# Podwatch Installer

## How It Works

Podwatch uses a "paste-a-prompt" installation flow:

1. **User signs up** at podwatch.app → generates an API key
2. **Dashboard shows** a pre-filled install prompt with their key baked in
3. **User pastes** the prompt into their OpenClaw agent chat
4. **Agent executes** all installation steps automatically
5. **Done** — monitoring starts within minutes

## What the User Sees on the Dashboard

```
┌─────────────────────────────────────────────────────┐
│  🚀 Install Podwatch on Your Agent                  │
│                                                      │
│  Copy this prompt and paste it into your agent chat: │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Install Podwatch monitoring on this agent.      │ │
│  │ My API key is: pw_k8x7f...                      │ │
│  │ Use gateway config.patch to add the podwatch    │ │
│  │ plugin config, then restart.                    │ │
│  │ Full instructions at                            │ │
│  │ https://podwatch.app/install                    │ │
│  └─────────────────────────────────────────────────┘ │
│                                        [📋 Copy]     │
│                                                      │
│  ⏱️ Takes about 2 minutes                           │
└─────────────────────────────────────────────────────┘
```

## Distribution Options

### Option A: Plugin Install (Recommended)
User installs the Podwatch plugin via CLI, then configures via `gateway config.patch`.

Prompt template:
```
Install Podwatch monitoring on this agent. My API key is: {{API_KEY}}
Use gateway config.patch to add the podwatch plugin config, then restart.
Full instructions at https://podwatch.app/install
```

### Option B: Inline Prompt (No Pre-install)
For users who want a single paste, the entire installation instructions
are embedded in the prompt. Longer but zero-step. See INLINE-PROMPT.md.

### Option C: URL Reference (Future)
When hosted, the installer SKILL.md can be fetched via URL:
```
Install Podwatch monitoring on this agent. My API key is: {{API_KEY}}

Fetch the installer instructions from https://podwatch.app/install/skill.md and follow every step.
```

## Testing

### Local Test (for development)
Paste this into your OpenClaw agent chat:
```
Install Podwatch monitoring on this agent using the local installer at /home/rafa/podwatch-plugin/installer/SKILL.md — my API key is: pw_test_key_123
```

### Production Test
```
Install Podwatch monitoring on this agent. My API key is: pw_live_key_xxx
Use gateway config.patch to add the podwatch plugin config, then restart.
Full instructions at https://podwatch.app/install
```

## Files

- `SKILL.md` — The installer instructions the agent reads and follows
- `INSTALL-PROMPT.md` — Documentation about the prompt templates
- `README.md` — This file
