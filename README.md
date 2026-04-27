# pi-kimi-provider

Kimi Membership Provider Extension for [Pi](https://pi.dev). Access Kimi models via OAuth device code flow (same as `kimi-code` / `kimi-cli`) or an optional Moonshot API key.

## Features

- **OAuth login** — authenticate via browser with `/login kimi`
- **API key support** — alternatively set `KIMI_API_KEY` environment variable
- **Model access** — use `kimi-for-coding` (Kimi-k2.6) with reasoning and image support
- **Token refresh** — automatic token refresh when access token expires
- **Usage tracking** — check subscription quota with `/kimi-usage`

## Installation

### Via Git (recommended)

```bash
pi install git:github.com/marad/pi-kimi-provider
```

### Local development

Clone the repository and add to your local extensions:

```bash
git clone https://github.com/marad/pi-kimi-provider.git ~/.pi/agent/extensions/pi-kimi-provider
cd ~/.pi/agent/extensions/pi-kimi-provider
npm install
```

Then reload Pi with `/reload`.

## Usage

1. **Select the provider:**
   ```
   /model kimi
   ```

2. **Authenticate (if not using API key):**
   ```
   /login kimi
   ```
   Follow the link to authorize Pi in your browser.

3. **Check usage:**
   ```
   /kimi-usage
   ```
   Shows your current subscription usage in the 5-hour window and weekly quota.

4. **Start chatting.**

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_API_KEY` | Optional Moonshot API key. If set, OAuth flow is skipped. |

## Supported Models

| Model | ID | Context | Max Tokens | Input | Reasoning |
|-------|-----|---------|------------|-------|-----------|
| Kimi-k2.6 (Coding) | `kimi-for-coding` | 262,144 | 32,000 | text, image | yes |

## License

MIT
