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
// Usage Info (reverse-engineered from kimi-cli)
// =============================================================================

interface KimiUsageResponse {
	usage?: Record<string, unknown>;
	limits?: Array<{
		detail?: Record<string, unknown>;
		window?: Record<string, unknown>;
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

interface UsageRow {
	label: string;
	used: number;
	limit: number;
	resetHint: string | null;
}

function toInt(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function resetHint(data: Record<string, unknown>): string | null {
	for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
		const val = data[key];
		if (val) return formatResetTime(String(val));
	}
	for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
		const seconds = toInt(data[key]);
		if (seconds) return `resets in ${formatDuration(seconds)}`;
	}
	return null;
}

function formatDuration(seconds: number): string {
	const hrs = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hrs > 0) return `${hrs}h ${mins}m`;
	if (mins > 0) return `${mins}m ${secs}s`;
	return `${secs}s`;
}

function formatResetTime(val: string): string {
	try {
		// Truncate nanoseconds to microseconds for JS Date compatibility
		let iso = val;
		if (iso.includes(".") && iso.endsWith("Z")) {
			const base = iso.slice(0, -1);
			const dotIdx = base.lastIndexOf(".");
			if (dotIdx > 0) {
				iso = base.slice(0, dotIdx + 1) + base.slice(dotIdx + 1, dotIdx + 7) + "Z";
			}
		}
		const dt = new Date(iso);
		if (Number.isNaN(dt.getTime())) return `resets at ${val}`;
		const now = Date.now();
		const delta = Math.floor((dt.getTime() - now) / 1000);
		if (delta <= 0) return "reset";
		return `resets in ${formatDuration(delta)}`;
	} catch {
		return `resets at ${val}`;
	}
}

function limitLabel(
	item: Record<string, unknown>,
	detail: Record<string, unknown>,
	window: Record<string, unknown>,
	idx: number,
): string {
	for (const key of ["name", "title", "scope"]) {
		const val = item[key] ?? detail[key];
		if (val) return String(val);
	}
	const duration =
		toInt(window.duration) ?? toInt(item.duration) ?? toInt(detail.duration);
	const timeUnit = String(
		window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "",
	);
	if (duration) {
		if (timeUnit.includes("MINUTE")) {
			if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
			return `${duration}m limit`;
		}
		if (timeUnit.includes("HOUR")) return `${duration}h limit`;
		if (timeUnit.includes("DAY")) return `${duration}d limit`;
		return `${duration}s limit`;
	}
	return `Limit #${idx + 1}`;
}

function toUsageRow(data: Record<string, unknown>, defaultLabel: string): UsageRow | null {
	const limit = toInt(data.limit);
	let used = toInt(data.used);
	if (used === null) {
		const remaining = toInt(data.remaining);
		if (remaining !== null && limit !== null) {
			used = limit - remaining;
		}
	}
	if (used === null && limit === null) return null;
	return {
		label: String(data.name ?? data.title ?? defaultLabel),
		used: used ?? 0,
		limit: limit ?? 0,
		resetHint: resetHint(data),
	};
}

function parseUsagePayload(payload: KimiUsageResponse): UsageRow[] {
	const rows: UsageRow[] = [];

	const usage = payload.usage;
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		const row = toUsageRow(usage, "Weekly limit");
		if (row) rows.push(row);
	}

	const limits = payload.limits;
	if (Array.isArray(limits)) {
		for (let idx = 0; idx < limits.length; idx++) {
			const item = limits[idx];
			if (!item || typeof item !== "object") continue;
			const detailRaw = item.detail;
			const detail =
				detailRaw && typeof detailRaw === "object" && !Array.isArray(detailRaw)
					? (detailRaw as Record<string, unknown>)
					: item;
			const windowRaw = item.window;
			const window =
				windowRaw && typeof windowRaw === "object" && !Array.isArray(windowRaw)
					? (windowRaw as Record<string, unknown>)
					: {};
			const label = limitLabel(item, detail, window, idx);
			const row = toUsageRow(detail, label);
			if (row) rows.push(row);
		}
	}

	return rows;
}

function renderBar(used: number, limit: number, width = 20): string {
	if (limit <= 0) return "";
	const ratio = (limit - used) / limit;
	const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
	const empty = width - filled;
	return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

function usageLabel(usedRatio: number): string {
	if (usedRatio >= 0.9) return "CRIT";
	if (usedRatio >= 0.7) return "WARN";
	return "GOOD";
}

function formatUsageRows(rows: UsageRow[]): string {
	const labelWidth = Math.max(6, ...rows.map((r) => r.label.length));
	const lines: string[] = [];

	for (const row of rows) {
		const usedRatio = row.limit > 0 ? row.used / row.limit : 0;
		const pctLeft = Math.round((1 - usedRatio) * 100);
		const bar = renderBar(row.used, row.limit);
		const status = usageLabel(usedRatio);
		const reset = row.resetHint ? ` (${row.resetHint})` : "";
		lines.push(
			`${row.label.padEnd(labelWidth)}  ${bar}  ${status}  ${pctLeft}% left${reset}`,
		);
	}

	return lines.join("\n");
}

async function fetchKimiUsage(apiKey: string): Promise<KimiUsageResponse> {
	const response = await fetch(`${KIMI_BASE_URL}/usages`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...getCommonHeaders(),
		},
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`HTTP ${response.status}: ${text}`);
	}

	return (await response.json()) as KimiUsageResponse;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("kimi-usage", {
		description: "Show Kimi subscription usage (5h window and weekly)",
		handler: async (_args, ctx) => {
			const apiKey = await ctx.modelRegistry.authStorage.getApiKey("kimi");
			if (!apiKey) {
				ctx.ui.notify(
					"No Kimi credentials found. Run /login kimi or set KIMI_API_KEY.",
					"error",
				);
				return;
			}

			try {
				const data = await fetchKimiUsage(apiKey);
				const rows = parseUsagePayload(data);

				let text = "**Kimi Usage**\n\n";
				if (rows.length > 0) {
					text += formatUsageRows(rows);
				} else {
					text += "No usage data available.\n\nRaw response:\n";
					text += "```json\n" + JSON.stringify(data, null, 2) + "\n```";
				}

				pi.sendMessage({
					customType: "kimi-usage",
					content: text.trim(),
					display: true,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to fetch Kimi usage: ${msg}`, "error");
			}
		},
	});

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
