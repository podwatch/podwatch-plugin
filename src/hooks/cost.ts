/**
 * Cost handler — subscribes to diagnostic events for LLM cost/token tracking.
 *
 * Listens for `model.usage` events via onDiagnosticEvent() and enqueues
 * cost records to the transmitter.
 */

import type { PodwatchConfig } from "../index.js";
import type { DiagnosticUsageEvent, DiagnosticEventPayload } from "../types.js";
import { transmitter } from "../transmitter.js";

/**
 * Register the cost handler.
 * Subscribes to diagnostic events if diagnostics are enabled.
 */
export function registerCostHandler(
  api: any,
  config: PodwatchConfig,
  diagnosticsEnabled: boolean
): void {
  if (!diagnosticsEnabled) {
    api.logger.warn("[podwatch/cost] Diagnostics disabled — cost tracking inactive");
    return;
  }

  // onDiagnosticEvent is available from openclaw/plugin-sdk at runtime
  // or on the api.runtime object. Try both approaches.
  let onDiagnosticEvent: ((listener: (evt: DiagnosticEventPayload) => void) => () => void) | undefined;

  // Check api.runtime first (most reliable for plugins)
  onDiagnosticEvent = api.runtime?.onDiagnosticEvent;

  if (!onDiagnosticEvent) {
    // At runtime, OpenClaw injects onDiagnosticEvent into the plugin environment.
    // If it's not on api.runtime, try the global scope (some versions expose it there).
    const g = globalThis as any;
    if (typeof g.__openclaw_onDiagnosticEvent === "function") {
      onDiagnosticEvent = g.__openclaw_onDiagnosticEvent;
    }
  }

  if (!onDiagnosticEvent) {
    api.logger.error(
      "[podwatch/cost] Could not access onDiagnosticEvent. Cost tracking unavailable."
    );
    return;
  }

  // Subscribe to diagnostic events
  const unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    if (evt.type !== "model.usage") return;

    const usage = evt as DiagnosticUsageEvent;

    transmitter.enqueue({
      type: "cost",
      ts: usage.ts,
      sessionKey: usage.sessionKey,
      sessionId: usage.sessionId,
      channel: usage.channel,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.usage.input,
      outputTokens: usage.usage.output,
      cacheReadTokens: usage.usage.cacheRead,
      cacheWriteTokens: usage.usage.cacheWrite,
      totalTokens: usage.usage.total,
      costUsd: usage.costUsd,
      durationMs: usage.durationMs,
      contextLimit: usage.context?.limit,
      contextUsed: usage.context?.used,
    });
  });

  api.logger.info("[podwatch/cost] Diagnostic event listener registered");

  // Store unsubscribe for cleanup (gateway_stop handler calls this)
  (api as any).__podwatch_unsubscribeDiagnostics = unsubscribe;
}
