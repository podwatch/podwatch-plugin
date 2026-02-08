---
name: podwatch
description: "Check Podwatch monitoring status, costs, budget, alerts, and scan installed skills/plugins."
version: 0.1.0
user-invocable: true
metadata: { "openclaw": { "emoji": "👁️" } }
---

# Podwatch Agent Commands

You have Podwatch cost monitoring and security installed. When the user asks about costs, budget, monitoring, or security — use these commands.

## Config

Your Podwatch API key is in your plugin config at `plugins.entries.podwatch.config.apiKey`. The endpoint is `plugins.entries.podwatch.config.endpoint` (default: `https://podwatch.app/api`).

To make API calls, use `web_fetch` with an `Authorization: Bearer <apiKey>` header. Read the API key from your gateway config first if you don't have it cached.

## Commands

### /podwatch status

Fetch agent monitoring status.

```
web_fetch URL: {endpoint}/status
Headers: Authorization: Bearer {apiKey}
```

Response fields: `agentOnline`, `eventsToday`, `lastHeartbeat`, `diagnosticsEnabled`, `pluginVersion`.

Show the user:
- Online/offline status
- Events collected today
- Last heartbeat time (relative, e.g. "2 minutes ago")
- Whether diagnostics are enabled

### /podwatch costs [today|week|month]

Fetch cost summary for a time period. Default: `today`.

```
web_fetch URL: {endpoint}/costs?period={period}
Headers: Authorization: Bearer {apiKey}
```

Response fields: `totalCostUsd`, `totalTokens`, `byModel[]` (model, cost, tokens, calls), `byTool[]` (tool, calls, avgDurationMs), `comparisonPct` (vs previous period).

Show the user:
- Total cost in USD (4 decimal places for small amounts, 2 for >$1)
- Total tokens (formatted with commas)
- Top 3 models by cost
- Top 3 tools by call count
- Comparison: "↑12% vs yesterday" or "↓5% vs last week"

### /podwatch budget

Fetch current budget state.

```
web_fetch URL: {endpoint}/budget
Headers: Authorization: Bearer {apiKey}
```

Response fields: `dailyLimit`, `currentSpend`, `remainingUsd`, `percentUsed`, `hardStopEnabled`.

Show the user:
- Current spend vs daily limit (e.g. "$3.42 / $10.00")
- Percentage bar (e.g. "████░░░░░░ 34%")
- Whether hard stop (budget enforcement) is enabled
- If >80%: warn them they're approaching the limit

### /podwatch alerts [count]

Fetch recent security alerts. Default count: 5.

```
web_fetch URL: {endpoint}/alerts?limit={count}
Headers: Authorization: Bearer {apiKey}
```

Response fields: `alerts[]` (severity, pattern, toolName, message, timestamp).

Show each alert with:
- Severity emoji: 🔴 critical, 🟠 high, 🟡 medium, 🟢 low
- Pattern name (exfiltration_sequence, first_time_tool, dangerous_operation, persistence_attempt)
- Tool that triggered it
- Relative timestamp

### /podwatch scan

Trigger a skill/plugin security scan.

```
web_fetch URL: {endpoint}/scan
Method: POST
Headers: Authorization: Bearer {apiKey}
```

Response fields: `skills[]`, `plugins[]` — each with name, source, version, riskIndicators[].

Show the user:
- Total skills and plugins found
- Any with risk indicators (highlight in red)
- Podwatch itself should show as verified ✅

## Response Style

- Keep responses concise — tables work well for costs and alerts
- Use emoji for severity levels
- Round costs: 4 decimals if <$1, 2 decimals if >=$1
- Always show the dashboard link at the bottom: "Full details → https://podwatch.app"
