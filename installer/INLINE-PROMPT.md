# Podwatch Inline Install Prompt

This is the self-contained version — the user pastes this ENTIRE block into their agent chat.
No SKILL.md needed, no pre-install step. The instructions ARE the prompt.

The dashboard will generate this with the user's API key pre-filled.

---

## Template (dashboard fills in {{API_KEY}})

```
Install Podwatch cost monitoring on this agent. Follow these steps exactly:

1. Install the plugin:
   Run: openclaw plugins install @podwatch/podwatch
   If that fails, manually copy to ~/.openclaw/extensions/podwatch/
   Verify: openclaw plugins list | grep -i podwatch
   If it doesn't appear, stop and tell me the error.

2. Get config hash first:
   Use gateway config.get tool → save the "hash" value.

3. Configure (use the gateway config.patch tool with baseHash from step 2):
   {
     "plugins": {
       "entries": {
         "podwatch": {
           "enabled": true,
           "config": {
             "apiKey": "{{API_KEY}}",
             "endpoint": "https://podwatch.app/api",
             "enableBudgetEnforcement": true,
             "enableSecurityAlerts": true
           }
         }
       }
     }
   }
   IMPORTANT: Use config.patch with baseHash, NOT config.apply.
   Do NOT include diagnostics in the patch.

4. Restart the gateway (gateway restart tool, reason: "Podwatch installed").

5. Wait 5 seconds, then verify:
   openclaw plugins list | grep -i podwatch (should show loaded)

6. Tell me the result.
```

---

## Changes from v1 (lessons learned from manual install)

- Removed `diagnostics.enabled` from config.patch — caused "invalid config" in some versions
- Added baseHash requirement — config.patch fails without it
- Changed from `-l` (link) to regular install — symlinks not followed by scanner
- Added fallback to manual copy if npm install fails
- Changed npm package name from `@podwatch/openclaw-plugin` to `@podwatch/podwatch`
