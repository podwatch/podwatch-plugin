/**
 * Cost handler — extracts token/cost data from before_agent_start messages.
 *
 * The plugin-sdk's onDiagnosticEvent is broken (separate module instances).
 * Instead, we use before_agent_start which provides the full session history
 * with usage data on every assistant message:
 *   { provider, model, usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } } }
 */

import type { PodwatchConfig } from "../index.js";
import { transmitter } from "../transmitter.js";

// Track processed messages to avoid double-counting
const processedTimestamps = new Set<number>();

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

    for (const msg of event.messages) {
      // Only assistant messages have usage data
      if (msg.role !== "assistant") continue;
      if (!msg.usage) continue;
      if (!msg.timestamp) continue;

      // Skip already-processed messages
      if (processedTimestamps.has(msg.timestamp)) continue;
      processedTimestamps.add(msg.timestamp);

      // Skip zero-cost internal messages (delivery-mirror, etc.)
      if (msg.provider === "openclaw" || msg.model === "delivery-mirror") continue;
      if (msg.usage.totalTokens === 0 && !msg.usage.input && !msg.usage.output) continue;

      const costTotal = msg.usage.cost?.total ?? undefined;

      transmitter.enqueue({
        type: "cost",
        ts: msg.timestamp,
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
        durationMs: undefined,
        // Tag heartbeat-triggered cost events so the dashboard can distinguish them
        ...(isHeartbeat ? { sessionType: "heartbeat" } : {}),
      });
    }

    // Prune old timestamps to prevent unbounded memory growth
    // Keep last 1000 entries
    if (processedTimestamps.size > 1000) {
      const arr = [...processedTimestamps].sort((a, b) => a - b);
      const toRemove = arr.slice(0, arr.length - 500);
      for (const ts of toRemove) processedTimestamps.delete(ts);
    }
  });

  api.logger.info("[podwatch/cost] Cost tracking via before_agent_start message history");
}
