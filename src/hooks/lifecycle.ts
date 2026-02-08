/**
 * Lifecycle handlers — gateway_start, gateway_stop, before_compaction.
 *
 * gateway_start: starts heartbeat interval + initial skill/plugin scan
 * gateway_stop: flushes pending events, stops intervals
 * before_compaction: tracks context window pressure
 */

import type { PodwatchConfig } from "../index.js";
import type {
  GatewayStartEvent,
  BeforeCompactionEvent,
  PluginHookAgentContext,
} from "../types.js";
import { transmitter } from "../transmitter.js";
import { scanSkillsAndPlugins } from "../scanner.js";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register lifecycle hook handlers.
 */
export function registerLifecycleHandlers(api: any, config: PodwatchConfig): void {
  console.log("[podwatch:debug] registerLifecycleHandlers() called");

  // -----------------------------------------------------------------------
  // Heartbeat + scan — run immediately during register() since
  // gateway_start is never emitted to plugins.
  // -----------------------------------------------------------------------

  // Send initial heartbeat right now
  console.log("[podwatch:debug] Starting heartbeat timer from register()");
  sendHeartbeat();

  // Start heartbeat interval
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, config.heartbeatIntervalMs ?? 60_000);
  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    heartbeatTimer.unref();
  }

  // Initial skill/plugin scan (fallback — also attempted in gateway_start)
  const workspaceDir = api.config?.agents?.defaults?.workspace;
  console.log("[podwatch:debug] Running initial scan from register()");
  void runScan(workspaceDir);

  // Start periodic scan interval
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(
    () => void runScan(workspaceDir),
    config.scanIntervalMs ?? 21_600_000
  );
  if (scanTimer && typeof scanTimer === "object" && "unref" in scanTimer) {
    scanTimer.unref();
  }

  api.logger.info(
    `[podwatch/lifecycle] Heartbeat & scan started from register(). Heartbeat: ${config.heartbeatIntervalMs ?? 60_000}ms, Scan: ${config.scanIntervalMs ?? 21_600_000}ms`
  );

  // -----------------------------------------------------------------------
  // gateway_start — best-effort re-scan (in case it ever fires)
  // -----------------------------------------------------------------------
  api.on(
    "gateway_start",
    async (event: GatewayStartEvent): Promise<void> => {
      console.log("[podwatch:debug] === gateway_start (best-effort) ===");
      console.log("[podwatch:debug] gateway_start event:", JSON.stringify(event, null, 2));

      // Re-run scan as best-effort; heartbeat is already running
      void runScan(api.config?.agents?.defaults?.workspace);
    }
  );

  // -----------------------------------------------------------------------
  // gateway_stop — graceful shutdown
  // -----------------------------------------------------------------------
  api.on(
    "gateway_stop",
    async (): Promise<void> => {
      console.log("[podwatch:debug] === gateway_stop ===");
      // Stop intervals
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
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
      console.log("[podwatch:debug] === before_compaction ===");
      console.log("[podwatch:debug] before_compaction event:", JSON.stringify(event, null, 2));
      console.log("[podwatch:debug] before_compaction ctx:", JSON.stringify(ctx, null, 2));
      transmitter.enqueue({
        type: "compaction",
        ts: Date.now(),
        messageCount: event.messageCount,
        tokenCount: event.tokenCount,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendHeartbeat(): void {
  transmitter.enqueue({
    type: "heartbeat",
    ts: Date.now(),
    bufferedEvents: transmitter.bufferedCount,
  });
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
