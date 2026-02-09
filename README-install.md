# podwatch-install

One-command [Podwatch](https://podwatch.app) plugin installer for [OpenClaw](https://openclaw.ai) agents.

## Quick Start

```bash
npx podwatch-install pw_your_api_key_here
```

That's it. The installer will:

1. ✅ Check your platform and OpenClaw version
2. 🔍 Validate your API key with the Podwatch server
3. 📦 Install the Podwatch plugin
4. 💾 Back up your current config
5. ⚙️ Configure the plugin (cost tracking, budget enforcement, security alerts)
6. 🔄 Restart the gateway to activate
7. 🎉 You're monitoring!

## No `npx`? No problem.

If `npx` isn't available, use `node` directly (always available on OpenClaw machines):

```bash
curl -sL https://podwatch.app/install.js | node - pw_your_api_key_here
```

Or the combined one-liner (tries `npx` first, falls back to `node`):

```bash
npx podwatch-install@latest pw_your_key 2>/dev/null || curl -sL https://podwatch.app/install.js | node - pw_your_key
```

## Prerequisites

- **Node.js** ≥ 16
- **OpenClaw** ≥ v2026.2.0 ([install guide](https://docs.openclaw.ai))
- **Linux or macOS** (Windows not supported — see [Compatibility](#compatibility))
- A **Podwatch API key** — get one at [podwatch.app/dashboard](https://podwatch.app/dashboard)

## Usage

```bash
# Install with your API key
npx podwatch-install pw_abc123def456

# Show help
npx podwatch-install --help
```

## What it configures

The installer modifies your OpenClaw config (`~/.openclaw/openclaw.json`) to add:

```json
{
  "diagnostics": {
    "enabled": true
  },
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

Existing configuration is preserved — only Podwatch-specific fields are added or updated. A `.bak` backup is created before any changes.

### Why `diagnostics.enabled`?

Podwatch relies on OpenClaw's diagnostics system (`onDiagnosticEvent`) to receive cost and usage data. Without `diagnostics.enabled: true`, cost tracking — Podwatch's primary feature — will not work. The installer enables this automatically.

## Idempotent

Safe to run multiple times. If Podwatch is already installed, the installer will update the API key/config and restart the gateway.

## Config file locations

The installer looks for the OpenClaw config in this order:

1. `$OPENCLAW_CONFIG` environment variable
2. `~/.openclaw/openclaw.json`
3. `~/.config/openclaw/openclaw.json`

If no config file exists, one is created at `~/.openclaw/openclaw.json`.

## Gateway restart behavior

The installer **backgrounds** the gateway restart. This means:

1. The installer prints the success message and exits
2. ~2 seconds later, the gateway stops and restarts
3. Your agent will go quiet for ~10 seconds during the restart
4. The agent comes back automatically on the next message or heartbeat

If you're running this inside your agent's chat (the intended flow), expect a brief silence after the install completes. Send any message to confirm your agent is back.

## Compatibility

### Operating Systems

| OS | Status | Notes |
|----|--------|-------|
| Linux (x64, arm64) | ✅ Supported | Primary platform for OpenClaw |
| macOS (Intel, Apple Silicon) | ✅ Supported | Full support |
| Windows | ❌ Not supported | Use WSL instead |
| FreeBSD / other Unix | ⚠️ Untested | May work if OpenClaw runs |

**Windows users:** OpenClaw itself doesn't natively run on Windows. If you're using OpenClaw via WSL (Windows Subsystem for Linux), run the installer inside your WSL terminal — it will work normally.

### OpenClaw Versions

| Version | Status | Notes |
|---------|--------|-------|
| ≥ v2026.2.0 | ✅ Supported | Plugin system available |
| < v2026.2.0 | ❌ Not supported | No plugin system — `openclaw plugins install` doesn't exist |

The installer checks the OpenClaw version at runtime and fails gracefully with an upgrade message if it's too old.

**Version detection:** The installer runs `openclaw --version` to check compatibility. If the version format is unrecognized (e.g., custom builds), it proceeds with a warning.

### Node.js Versions

| Version | Status |
|---------|--------|
| ≥ 22.x | ✅ Recommended (ships with current OpenClaw) |
| ≥ 16.x | ✅ Supported |
| < 16.x | ❌ Not supported |

### Package Managers

| Manager | Install Command |
|---------|----------------|
| npm / npx | `npx podwatch-install pw_key` |
| Direct node | `curl -sL https://podwatch.app/install.js \| node - pw_key` |
| pnpm | `pnpm dlx podwatch-install pw_key` |
| bun | `bunx podwatch-install pw_key` |
| yarn | `yarn dlx podwatch-install pw_key` |

### Known Caveats

#### `diagnostics.enabled` on older OpenClaw versions

Some very early OpenClaw builds may not recognize `diagnostics` as a valid top-level config key. If the gateway fails to start after install:

1. Check `~/.openclaw/openclaw.json` for the `diagnostics` key
2. Try removing it: `"diagnostics": { "enabled": true }` → remove that block
3. Restart: `openclaw gateway start`
4. Note: cost tracking will not work without diagnostics enabled

This is rare — any OpenClaw version that supports plugins (≥ v2026.2.0) also supports `diagnostics.enabled`.

#### Config file permissions

The installer needs write access to the OpenClaw config file. If you get permission errors:

```bash
ls -la ~/.openclaw/openclaw.json
# Should be owned by your user with rw permissions
```

#### Strict config validation (`additionalProperties: false`)

OpenClaw validates plugin config against the plugin's schema. The installer only sets fields that are declared in the Podwatch plugin manifest (`apiKey`, `endpoint`, `enableBudgetEnforcement`, `enableSecurityAlerts`). Adding custom/undeclared fields to the podwatch config section will cause validation errors.

#### Plugin not loading after restart

New plugins require a **full gateway stop/start** (not just a SIGUSR1 hot-reload). The installer handles this automatically via a backgrounded restart. If the plugin doesn't appear in `openclaw plugins list` after install, manually restart:

```bash
openclaw gateway stop && sleep 3 && openclaw gateway start
```

#### Multiple config locations

If you have config files in multiple locations (`~/.openclaw/`, `~/.config/openclaw/`, and `$OPENCLAW_CONFIG`), the installer modifies only the first one found (in the order listed above). Make sure your active config is the one being modified.

## Troubleshooting

### OpenClaw not found

Install OpenClaw first: [docs.openclaw.ai](https://docs.openclaw.ai)

### Gateway won't start

```bash
openclaw gateway start
openclaw gateway logs
```

### Plugin install fails

Try manual install:

```bash
openclaw plugins install podwatch
```

If that fails, check your internet connection and try again.

### Config was corrupted

Restore from backup:

```bash
cp ~/.openclaw/openclaw.json.bak ~/.openclaw/openclaw.json
openclaw gateway start
```

### API key rejected

- Make sure you copied the full key (starts with `pw_`)
- Check your key at [podwatch.app/dashboard](https://podwatch.app/dashboard)
- Keys are tied to your account — don't share them

### Cost tracking shows no data

- Verify `diagnostics.enabled` is `true` in your config
- Check that the plugin is loaded: `openclaw plugins list | grep podwatch`
- Wait a few minutes — events are batched and sent periodically

## Zero dependencies

This package uses only Node.js built-in modules (`fs`, `path`, `os`, `https`, `child_process`). No `node_modules` needed.

## License

MIT
