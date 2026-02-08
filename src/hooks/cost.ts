/**
 * Cost handler — subscribes to diagnostic events for LLM cost/token tracking.
 *
 * Listens for `model.usage` events via onDiagnosticEvent() and enqueues
 * cost records to the transmitter.
 */

import type { PodwatchConfig } from "../index.js";
import type { DiagnosticUsageEvent, DiagnosticEventPayload } from "../types.js";
import { transmitter } from "../transmitter.js";
// Dynamic import at runtime — TypeScript can't resolve openclaw/plugin-sdk at build time
let sdkOnDiagnosticEvent: ((listener: (evt: any) => void) => () => void) | undefined;

/**
 * Register the cost handler.
 * Subscribes to diagnostic events if diagnostics are enabled.
 */
export function registerCostHandler(
  api: any,
  config: PodwatchConfig,
  diagnosticsEnabled: boolean
): void {
  console.log("[podwatch:debug] registerCostHandler() called, diagnosticsEnabled:", diagnosticsEnabled);
  if (!diagnosticsEnabled) {
    console.log("[podwatch:debug] registerCostHandler() — skipping (diagnostics disabled)");
    api.logger.warn("[podwatch/cost] Diagnostics disabled — cost tracking inactive");
    return;
  }

  // Resolve onDiagnosticEvent from the openclaw plugin-sdk
  // The SDK is installed globally; plugins can't resolve it via normal require()
  const resolveSDK = (): ((listener: (evt: any) => void) => () => void) | undefined => {
    // Try normal require first
    try { return require("openclaw/plugin-sdk").onDiagnosticEvent; } catch { /* noop */ }
    // Try api.runtime
    if (api.runtime?.onDiagnosticEvent) return api.runtime.onDiagnosticEvent;
    // Try globalThis
    if (typeof (globalThis as any).__openclaw_onDiagnosticEvent === "function") {
      return (globalThis as any).__openclaw_onDiagnosticEvent;
    }
    // Find openclaw installation and load SDK directly
    try {
      const path = require("path");
      const fs = require("fs");
      const candidates = [
        // npm global
        path.resolve(process.env.HOME || "", ".npm-global/lib/node_modules/openclaw/dist/plugin-sdk/index.js"),
        // pnpm global
        path.resolve(process.env.HOME || "", ".local/share/pnpm/global/5/node_modules/openclaw/dist/plugin-sdk/index.js"),
        // system global
        "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
        "/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
        // relative to plugin
        path.resolve(__dirname, "../../node_modules/openclaw/dist/plugin-sdk/index.js"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          // Use eval to bypass TypeScript/bundler require rewriting
          const mod = eval(`require(${JSON.stringify(c)})`);
          if (typeof mod.onDiagnosticEvent === "function") return mod.onDiagnosticEvent;
        }
      }
    } catch { /* noop */ }
    return undefined;
  };
  sdkOnDiagnosticEvent = resolveSDK();
  console.log("[podwatch:debug] sdkOnDiagnosticEvent resolved:", typeof sdkOnDiagnosticEvent);

  if (!sdkOnDiagnosticEvent) {
    api.logger.error(
      "[podwatch/cost] Could not access onDiagnosticEvent. Cost tracking unavailable."
    );
    return;
  }

  // Subscribe to diagnostic events
  console.log("[podwatch:debug] Subscribing to diagnostic events...");
  const unsubscribe = sdkOnDiagnosticEvent((evt: DiagnosticEventPayload) => {
    console.log("[podwatch:debug] Diagnostic event received, type:", evt.type);
    console.log("[podwatch:debug] Diagnostic event payload:", JSON.stringify(evt, null, 2)?.slice(0, 1000));
    if (evt.type !== "model.usage") {
      console.log("[podwatch:debug] Ignoring non-model.usage event:", evt.type);
      return;
    }

    const usage = evt as DiagnosticUsageEvent;
    console.log("[podwatch:debug] model.usage event — provider:", usage.provider, "model:", usage.model, "costUsd:", usage.costUsd, "tokens:", usage.usage?.total);

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
