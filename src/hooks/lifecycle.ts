/**
 * Lifecycle handlers — gateway_start, gateway_stop, before_compaction.
 *
 * register(): starts pulse interval + initial skill/plugin scan
 * gateway_stop: flushes pending events, stops intervals
 * before_compaction: tracks context window pressure
 *
 * Pulse = Podwatch plugin's lightweight alive-ping (direct HTTP, no LLM cost).
 * This is NOT OpenClaw's agent heartbeat (which triggers LLM turns).
 */

import type { PodwatchConfig } from "../index.js";
import type {
  GatewayStartEvent,
  BeforeCompactionEvent,
  PluginHookAgentContext,
} from "../types.js";
import { transmitter } from "../transmitter.js";
import { scanSkillsAndPlugins } from "../scanner.js";

let pulseTimer: ReturnType<typeof setInterval> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register lifecycle hook handlers.
 */
export function registerLifecycleHandlers(api: any, config: PodwatchConfig): void {
  const endpoint = config.endpoint ?? "https://podwatch.app/api";
  const apiKey = config.apiKey;

  // -----------------------------------------------------------------------
  // Pulse + scan — run immediately during register() since
  // gateway_start is never emitted to plugins.
  // -----------------------------------------------------------------------

  // Send initial pulse right now
  void sendPulse(endpoint, apiKey);

  // Start pulse interval (default 5 minutes)
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = setInterval(
    () => void sendPulse(endpoint, apiKey),
    config.pulseIntervalMs ?? 300_000
  );
  if (pulseTimer && typeof pulseTimer === "object" && "unref" in pulseTimer) {
    pulseTimer.unref();
  }

  // Initial skill/plugin scan — delayed 30s to let gateway fully settle
  const workspaceDir = api.config?.agents?.defaults?.workspace;
  setTimeout(() => void runScan(workspaceDir), 30_000);

  // Start periodic scan interval (default 6h)
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(
    () => void runScan(workspaceDir),
    config.scanIntervalMs ?? 21_600_000
  );
  if (scanTimer && typeof scanTimer === "object" && "unref" in scanTimer) {
    scanTimer.unref();
  }

  api.logger.info(
    `[podwatch/lifecycle] Pulse & scan started from register(). Pulse: ${config.pulseIntervalMs ?? 300_000}ms, Scan: ${config.scanIntervalMs ?? 21_600_000}ms`
  );

  // -----------------------------------------------------------------------
  // gateway_start — best-effort re-scan (in case it ever fires)
  // -----------------------------------------------------------------------
  api.on(
    "gateway_start",
    async (event: GatewayStartEvent): Promise<void> => {
      // Re-run scan as best-effort; pulse is already running
      void runScan(api.config?.agents?.defaults?.workspace);
    }
  );

  // -----------------------------------------------------------------------
  // gateway_stop — graceful shutdown
  // -----------------------------------------------------------------------
  api.on(
    "gateway_stop",
    async (): Promise<void> => {
      // Stop intervals
      if (pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }

      // Unsubscribe from diagnostic events
      const unsubscribe = (api as any).__podwatch_unsubscribeDiagnostics;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }

      // Flush remaining events
      await transmitter.shutdown();

      api.logger.info("[podwatch/lifecycle] Graceful shutdown complete");
    }
  );

  // -----------------------------------------------------------------------
  // before_compaction — context window pressure
  // -----------------------------------------------------------------------
  api.on(
    "before_compaction",
    async (event: BeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void> => {
      transmitter.enqueue({
        type: "compaction",
        ts: Date.now(),
        messageCount: event.messageCount,
        tokenCount: event.tokenCount,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });

      // Context pressure alert — only if both fields are available
      if (
        typeof event.tokenCount === "number" &&
        typeof (event as any).contextLimit === "number"
      ) {
        const contextLimit = (event as any).contextLimit as number;
        const ratio = event.tokenCount / contextLimit;
        if (ratio > 0.8) {
          transmitter.enqueue({
            type: "alert",
            ts: Date.now(),
            severity: "warning",
            pattern: "context_pressure",
            tokenCount: event.tokenCount,
            contextLimit,
            ratio,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        }
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a lightweight pulse directly to the Podwatch API.
 * This bypasses the transmitter/events pipeline entirely —
 * pulses go to their own dedicated endpoint.
 */
async function sendPulse(endpoint: string, apiKey: string): Promise<void> {
  try {
    const response = await fetch(`${endpoint}/pulse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ts: Date.now(),
        bufferedEvents: transmitter.bufferedCount,
        uptimeHours: transmitter.getAgentUptimeHours(),
        pluginVersion: "0.1.0",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[podwatch/pulse] API ${response.status}`);
    }
  } catch (err) {
    console.error("[podwatch/pulse] Failed:", err);
  }
}

async function runScan(workspaceDir?: string): Promise<void> {
  try {
    const results = await scanSkillsAndPlugins(workspaceDir);
    transmitter.enqueue({
      type: "scan",
      ts: Date.now(),
      ...results,
    });
  } catch (err) {
    console.error("[podwatch/lifecycle] Scan failed:", err);
  }
}
