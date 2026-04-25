/**
 * Kimi Membership Provider Extension for Pi
 *
 * Uses Kimi membership (same as kimi-code/kimi-cli) to access Kimi models.
 * Authentication via OAuth device code flow through https://auth.kimi.com.
 *
 * Usage:
 *   /login kimi           — authenticate via browser
 *   /model kimi            — select a Kimi model
 *
 * Alternatively, set KIMI_API_KEY environment variable with a Moonshot API key.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Constants
// =============================================================================

const KIMI_AUTH_HOST = "https://auth.kimi.com";
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_DEVICE_CODE_ENDPOINT = `${KIMI_AUTH_HOST}/api/oauth/device_authorization`;
const KIMI_TOKEN_ENDPOINT = `${KIMI_AUTH_HOST}/api/oauth/token`;
const KIMI_DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const KIMI_DEVICE_ID_PATH = path.join(os.homedir(), ".kimi", "device_id");

// =============================================================================
// Device ID — shared with kimi-code for consistent device identification
// =============================================================================

function getDeviceId(): string {
	try {
		return fs.readFileSync(KIMI_DEVICE_ID_PATH, "utf-8").trim();
	} catch {
		const id = crypto.randomUUID().replace(/-/g, "");
		try {
			fs.mkdirSync(path.dirname(KIMI_DEVICE_ID_PATH), { recursive: true });
			fs.writeFileSync(KIMI_DEVICE_ID_PATH, id);
		} catch {
			// Ignore write errors
		}
		return id;
	}
}

// =============================================================================
// Common Headers — required by Kimi API to identify as a coding agent
// =============================================================================

function getCommonHeaders(): Record<string, string> {
	return {
		"User-Agent": "KimiCLI/1.39.0",
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Device-Id": getDeviceId(),
		"X-Msh-Device-Name": os.hostname(),
		"X-Msh-Device-Model": `${process.platform} ${process.arch}`,
		"X-Msh-Os-Version": os.release(),
	};
}

// =============================================================================
// Helper: abortable sleep
// =============================================================================

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

// =============================================================================
// OAuth: Device Code Flow
// =============================================================================

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	token_type: string;
	expires_in: number;
	scope?: string;
}

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const body = new URLSearchParams({
		client_id: KIMI_CLIENT_ID,
	});

	const response = await fetch(KIMI_DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getCommonHeaders(),
		},
		body: body.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Device code request failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as DeviceCodeResponse;
	if (!data.device_code || !data.user_code) {
		throw new Error("Invalid device code response");
	}

	return data;
}

async function pollForToken(
	deviceCode: string,
	intervalSeconds: number | undefined,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	const resolvedInterval =
		typeof intervalSeconds === "number" && intervalSeconds > 0 ? intervalSeconds : 5;
	let intervalMs = Math.max(1000, resolvedInterval * 1000);

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");

		const body = new URLSearchParams({
			grant_type: KIMI_DEVICE_CODE_GRANT,
			client_id: KIMI_CLIENT_ID,
			device_code: deviceCode,
		});

		const response = await fetch(KIMI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...getCommonHeaders(),
			},
			body: body.toString(),
		});

		let data: (TokenResponse & { error?: string; error_description?: string }) | null = null;
		const text = await response.text();
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
		}

		if (response.ok && data?.access_token) {
			return data;
		}

		const error = data?.error;
		switch (error) {
			case "authorization_pending":
				await abortableSleep(intervalMs, signal);
				continue;
			case "slow_down":
				intervalMs = Math.min(intervalMs + 5000, 15000);
				await abortableSleep(intervalMs, signal);
				continue;
			case "expired_token":
				throw new Error("Device code expired. Please restart authentication.");
			case "access_denied":
				throw new Error("Authorization denied by user.");
			default:
				if (!response.ok) {
					await abortableSleep(intervalMs, signal);
					continue;
				}
				throw new Error(`Unexpected token response: ${text}`);
		}
	}

	throw new Error("Authentication timed out. Please try again.");
}

// =============================================================================
// OAuth Callbacks for Pi
// =============================================================================

async function loginKimi(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deviceCode = await startDeviceFlow();

	const authUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
	callbacks.onAuth({ url: authUrl });

	const tokenResponse = await pollForToken(
		deviceCode.device_code,
		deviceCode.interval,
		deviceCode.expires_in,
		callbacks.signal,
	);

	const expiresAt = Date.now() + tokenResponse.expires_in * 1000 - 60_000;

	return {
		refresh: tokenResponse.refresh_token || "",
		access: tokenResponse.access_token,
		expires: expiresAt,
	};
}

async function refreshKimiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: KIMI_CLIENT_ID,
		refresh_token: credentials.refresh,
	});

	const response = await fetch(KIMI_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getCommonHeaders(),
		},
		body: body.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as TokenResponse;
	if (!data.access_token) {
		throw new Error("Token refresh failed: no access token");
	}

	const expiresAt = Date.now() + data.expires_in * 1000 - 60_000;

	return {
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: expiresAt,
	};
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("kimi", {
		baseUrl: KIMI_BASE_URL,
		apiKey: "KIMI_API_KEY",
		api: "openai-completions",
		headers: getCommonHeaders(),

		models: [
			{
				id: "kimi-for-coding",
				name: "Kimi-k2.6 (Coding)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32000,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
					thinkingFormat: "deepseek",
				},
			},
		],

		oauth: {
			name: "Kimi Membership",
			login: loginKimi,
			refreshToken: refreshKimiToken,
			getApiKey: (cred) => cred.access,
		},
	});
}
