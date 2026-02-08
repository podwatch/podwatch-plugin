# Podwatch Installer Prompt

## What This Is

This is the "paste-a-prompt" that users paste into their OpenClaw agent chat to install Podwatch.
The user gets this prompt from podwatch.app after signing up and generating an API key.

## How To Use

1. User signs up at podwatch.app
2. User generates an API key (gets something like `pw_abc123...`)
3. User copies the installer prompt below (pre-filled with their API key)
4. User pastes it into their OpenClaw agent chat
5. Agent reads the SKILL.md, executes the steps, verifies, done

## The Prompt

The prompt the dashboard generates for the user will look like:

```
Install Podwatch monitoring on this agent. My API key is: pw_THEIR_KEY_HERE

Follow the installer instructions at: https://raw.githubusercontent.com/jaime-perez-dev/podwatch-plugin/main/installer/SKILL.md
```

For our testing (local), we'll use:

```
Install Podwatch monitoring on this agent using the local installer at /home/rafa/podwatch-plugin/installer/SKILL.md — my API key is: pw_test_key_123
```
