/**
 * Cost handler — extracts token/cost data from before_agent_start messages.
 *
 * The plugin-sdk's onDiagnosticEvent is broken (separate module instances).
 * Instead, we use before_agent_start which provides the full session history
 * with usage data on every assistant message:
 *   { provider, model, usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } } }
 *
 * Dedup strategy: lastSeenIndex tracks how far we've read into event.messages.
 * Each invocation only processes messages from lastSeenIndex onwards, then
 * advances the pointer. Zero memory growth, O(1) bookkeeping.
 * 
 * Cost events are correlated per LLM turn (not per tool call) using turn_id.
 */

import type { PodwatchConfig } from "../index.js";
import { transmitter } from "../transmitter.js";

// Track how far into event.messages we've already processed — per session
const lastSeenIndexMap = new Map<string, number>();

/**
 * Generate a turn-based correlation ID for cost events.
 * Cost events correlate to LLM turns, not individual tool calls.
 */
function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Reset all dedup state (exported for testing).
 */
export function _resetCostState(): void {
  lastSeenIndexMap.clear();
}

/**
 * Clear a single session's index (call on session_end to prevent memory leaks).
 */
export function _clearSessionIndex(sessionKey: string): void {
  lastSeenIndexMap.delete(sessionKey);
}

/**
 * Register the cost handler via before_agent_start hook.
 */
export function registerCostHandler(
  api: any,
  config: PodwatchConfig,
  diagnosticsEnabled: boolean
): void {
  // before_agent_start carries the full message history with usage on each assistant turn
  api.on("before_agent_start", async (event: any, ctx: any) => {
    if (!event?.messages || !Array.isArray(event.messages)) return;

    const sessionKey: string = ctx?.sessionKey ?? "__default__";

    // Get per-session index (defaults to 0 for new sessions)
    let lastSeenIndex = lastSeenIndexMap.get(sessionKey) ?? 0;

    // Bounds check: if messages were compacted, reset to 0
    if (lastSeenIndex > event.messages.length) {
      lastSeenIndex = 0;
    }

    // Only process new messages since last invocation
    const newMessages = event.messages.slice(lastSeenIndex);
    lastSeenIndexMap.set(sessionKey, event.messages.length);

    if (newMessages.length === 0) return;

    // Detect heartbeat-triggered turns by scanning the last user message
    // OpenClaw heartbeat prompts always contain "HEARTBEAT" (e.g. "Read HEARTBEAT.md")
    let isHeartbeat = false;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m?.role === "user") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        if (/HEARTBEAT/i.test(text)) {
          isHeartbeat = true;
        }
        break; // only check the last user message
      }
    }

    // Generate a turn_id for this batch of cost events (per before_agent_start invocation)
    // This links all cost events from the same LLM turn together
    const turnId = generateTurnId();

    for (const msg of newMessages) {
      // Only assistant messages have usage data
      if (msg.role !== "assistant") continue;
      if (!msg.usage) continue;

      // Skip zero-cost internal messages (delivery-mirror, etc.)
      if (msg.provider === "openclaw" || msg.model === "delivery-mirror") continue;
      if (msg.usage.totalTokens === 0 && !msg.usage.input && !msg.usage.output) continue;

      const costTotal = msg.usage.cost?.total ?? undefined;

      transmitter.enqueue({
        type: "cost",
        ts: msg.timestamp ?? Date.now(),
        sessionKey: ctx?.sessionKey,
        agentId: ctx?.agentId,
        provider: msg.provider,
        model: msg.model,
        inputTokens: msg.usage.input ?? 0,
        outputTokens: msg.usage.output ?? 0,
        cacheReadTokens: msg.usage.cacheRead ?? 0,
        cacheWriteTokens: msg.usage.cacheWrite ?? 0,
        totalTokens: msg.usage.totalTokens ?? ((msg.usage.input ?? 0) + (msg.usage.output ?? 0)),
        costUsd: costTotal,
        costBreakdown: msg.usage.cost, // full {input, output, cacheRead, cacheWrite, total} object
        durationMs: undefined,
        correlationId: turnId, // Link cost events per turn
        // Tag heartbeat-triggered cost events so the dashboard can distinguish them
        ...(isHeartbeat ? { sessionType: "heartbeat" } : {}),
      });
    }
  }, { name: "podwatch-cost" });

  // Clean up session index on session end to prevent memory leaks
  api.on("session_end", async (_event: any, ctx: any) => {
    const sessionKey: string = ctx?.sessionKey;
    if (sessionKey) {
      lastSeenIndexMap.delete(sessionKey);
    }
  }, { name: "podwatch-cost-cleanup" });

  api.logger.info("[podwatch/cost] Cost tracking via before_agent_start message history");
}
