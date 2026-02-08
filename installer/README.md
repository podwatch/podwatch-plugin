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
│  │ Install Podwatch on this agent.                 │ │
│  │ My API key is: pw_k8x7f...                      │ │
│  │                                                 │ │
│  │ Read the installer at                           │ │
│  │ ~/.openclaw/skills/podwatch-installer/SKILL.md  │ │
│  │ and follow every step exactly.                  │ │
│  └─────────────────────────────────────────────────┘ │
│                                        [📋 Copy]     │
│                                                      │
│  ⏱️ Takes about 2 minutes                           │
└─────────────────────────────────────────────────────┘
```

## Distribution Options

### Option A: Pre-installed Installer Skill (Recommended)
User installs the lightweight installer skill first (via ClawHub or `openclaw skills install`),
then the paste-a-prompt references the local SKILL.md.

Prompt template:
```
Install Podwatch on this agent. My API key is: {{API_KEY}}

Read the installer at ~/.openclaw/skills/podwatch-installer/SKILL.md and follow every step.
```

### Option B: Inline Prompt (No Pre-install)
For users who don't want to install the skill first, the entire SKILL.md
content is embedded in the prompt. Longer but zero-step.

### Option C: URL Reference (Future)
When hosted, the SKILL.md can be fetched via URL:
```
Install Podwatch on this agent. My API key is: {{API_KEY}}

Fetch the installer instructions from https://podwatch.app/install/skill.md and follow every step.
```

## Testing

### Local Test (for development)
Paste this into your OpenClaw agent chat:
```
Install Podwatch on this agent using the local installer skill at /home/rafa/podwatch-plugin/installer/SKILL.md — my API key is: pw_test_key_123
```

### Production Test
```
Install Podwatch on this agent. My API key is: pw_live_key_xxx

Read the installer at ~/.openclaw/skills/podwatch-installer/SKILL.md and follow every step.
```

## Files

- `SKILL.md` — The installer instructions the agent reads and follows
- `INSTALL-PROMPT.md` — Documentation about the prompt templates
- `README.md` — This file
