# Podwatch

Agent security monitoring, cost tracking, and budget enforcement for [OpenClaw](https://openclaw.ai).

## Quick Install

```bash
npx podwatch pw_your_api_key_here
```

That's it. The installer will validate your key, install the plugin to `~/.openclaw/extensions/podwatch/`, configure it, and restart the gateway.

## What You Get

- **Cost tracking** — per-call LLM cost and token monitoring
- **Budget enforcement** — block tool calls when spend exceeds limits
- **Security alerts** — detect risky tool usage patterns
- **Agent pulse** — online status and heartbeat monitoring
- **Dashboard** — [podwatch.app](https://podwatch.app)

## Prerequisites

- **Node.js** ≥ 16
- **OpenClaw** ≥ v2026.2.0
- **Linux or macOS** (Windows: use WSL)
- A **Podwatch API key** — get one at [podwatch.app/dashboard](https://podwatch.app/dashboard)

## Usage Modes

### As an installer (npx)

```bash
# Install with your API key
npx podwatch pw_abc123def456

# Show help
npx podwatch --help
```

The installer:
1. Validates your API key
2. Checks OpenClaw is installed and compatible
3. Copies the plugin to `~/.openclaw/extensions/podwatch/`
4. Configures the plugin in `~/.openclaw/openclaw.json`
5. Restarts the gateway to activate

### As an OpenClaw plugin

The plugin is what gets installed to `~/.openclaw/extensions/podwatch/`. It hooks into OpenClaw's event system to capture diagnostics, enforce budgets, and send security alerts to the Podwatch dashboard.

Plugin source is in `src/` (TypeScript), compiled to `dist/`.

## No `npx`? No problem.

```bash
curl -sL https://podwatch.app/install.js | node - pw_your_api_key_here
```

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm run clean    # Remove dist/
```

## Configuration

The installer adds this to `~/.openclaw/openclaw.json`:

```json
{
  "diagnostics": { "enabled": true },
  "plugins": {
    "entries": {
      "podwatch": {
        "enabled": true,
        "config": {
          "apiKey": "pw_your_key",
          "endpoint": "https://podwatch.app/api",
          "enableBudgetEnforcement": true,
          "enableSecurityAlerts": true
        }
      }
    }
  }
}
```

## License

BSD-3-Clause
