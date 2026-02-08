---
name: podwatch-installer
description: "Install Podwatch — cost monitoring, budget enforcement, and security alerts for your OpenClaw agent. Paste this with your API key to get started."
version: 0.1.1
user-invocable: true
metadata: { "openclaw": { "emoji": "👁️" } }
---

# Podwatch Installer

You are installing Podwatch, a cost monitoring and security plugin for OpenClaw agents.

**Follow these steps EXACTLY in order. Do NOT skip steps. Do NOT improvise.**

## Step 0 — Extract API Key

The user's message contains their Podwatch API key. Extract it now.
- It starts with `pw_` and is a long alphanumeric string.
- If you cannot find an API key in the user's message, STOP and ask: "I need your Podwatch API key to continue. Sign up at https://podwatch.app to get one."
- Save the key for later steps. Call it `PODWATCH_API_KEY`.

## Step 1 — Check Prerequisites

```bash
which openclaw || echo "FAIL: openclaw not found"
openclaw gateway status 2>/dev/null | head -3 || echo "FAIL: gateway not running"
```

**If `openclaw` not found:** "OpenClaw CLI must be installed. Visit https://docs.openclaw.ai"
**If gateway not running:** "Run `openclaw gateway start` first."

## Step 2 — Install the Plugin

Try the npm install first:
```bash
openclaw plugins install @podwatch/podwatch 2>&1
```

**If it fails** (404, not found, or any error), fall back to manual install:
```bash
# Download and extract to extensions directory
mkdir -p ~/.openclaw/extensions/podwatch
npm pack @podwatch/podwatch 2>/dev/null && tar -xzf podwatch-podwatch-*.tgz -C ~/.openclaw/extensions/podwatch --strip-components=1 && rm -f podwatch-podwatch-*.tgz
```

**If both fail**, tell the user: "Could not install Podwatch automatically. Please visit https://podwatch.app/docs/install for manual instructions."

**IMPORTANT:** Do NOT use `openclaw plugins install -l` (link mode) — symlinks are not followed by the OpenClaw extension scanner.

**Verify installation:**
```bash
openclaw plugins list 2>/dev/null | grep -i podwatch
```

If podwatch does NOT appear, STOP and report the error.

## Step 3 — Configure the Plugin

Use the `gateway` tool with action `config.patch`.

**IMPORTANT RULES:**
- You MUST use `config.patch`, NOT `config.apply`. `config.apply` replaces the entire config.
- You MUST first get the current config hash with `gateway config.get`, then pass it as `baseHash`.
- Do NOT include `diagnostics` in the patch — it may not be a valid top-level config key in all versions.

First, get the config hash:
```
gateway config.get → extract the "hash" field from the response
```

Then patch with this JSON (replace PODWATCH_API_KEY with the real key):
```json
{
  "plugins": {
    "entries": {
      "podwatch": {
        "enabled": true,
        "config": {
          "apiKey": "PODWATCH_API_KEY",
          "endpoint": "https://podwatch.app/api",
          "enableBudgetEnforcement": true,
          "enableSecurityAlerts": true
        }
      }
    }
  }
}
```

Pass the `baseHash` from config.get to prevent clobbering concurrent edits.

## Step 4 — Restart the Gateway

```
Use the gateway tool with action "restart" and reason "Podwatch plugin installed"
```

Wait 5 seconds after restart for the gateway to fully initialize.

## Step 5 — Verify Installation

After the gateway restarts, verify everything is working:

```bash
# 1. Check plugin is loaded and enabled
openclaw plugins list 2>/dev/null | grep -i podwatch

# 2. Check gateway log for podwatch messages
log_file="/tmp/openclaw/openclaw-$(date +%F).log"
if [ -f "$log_file" ]; then
    grep -i "podwatch" "$log_file" | tail -5
fi
```

## Step 6 — Report to User

**If successful:**
> ✅ **Podwatch installed successfully!**
>
> - Plugin: enabled
> - Budget enforcement: on
> - Security alerts: on
> - Dashboard: https://podwatch.app
>
> Your agent is now being monitored. Cost data, session tracking, and security alerts will appear on your dashboard within a few minutes.
>
> **Quick commands:**
> - "What are my agent costs today?"
> - "Show my Podwatch alerts"
> - "What's my budget status?"

**If any step failed:**
> ❌ **Podwatch installation incomplete**
>
> Step that failed: [which step]
> Error: [what went wrong]
>
> Try: [specific fix suggestion]
> Help: https://podwatch.app/docs/troubleshooting

## Known Issues & Workarounds

### "plugin id mismatch" warning
Cosmetic only. The plugin still works. Happens when the npm package name doesn't match the manifest id. Safe to ignore.

### "No API key configured" during install
Expected if the plugin loads before config.patch applies. The config.patch + restart fixes this.

### Symlinks not followed
OpenClaw's extension scanner does not follow symlinks. Always use a direct copy (`cp -r`) or `openclaw plugins install` (non-link mode).

### config.patch returns "invalid config"
Most likely cause: missing `baseHash`. Always get the hash from `gateway config.get` first and include it in the patch call.

### diagnostics.enabled
Some OpenClaw versions don't accept `diagnostics` as a top-level config key via config.patch. If cost tracking shows no data, the user may need to manually add `"diagnostics": { "enabled": true }` to `~/.openclaw/openclaw.json` and restart the gateway.
