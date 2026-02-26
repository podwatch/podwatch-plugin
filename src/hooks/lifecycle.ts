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
import { initSnapshot, checkConfigChanges, resetSnapshot } from "../config-monitor.js";
import { startAuthMonitor, stopAuthMonitor, checkAuthHealth } from "./auth-monitor.js";
import { startChannelMonitor, stopChannelMonitor } from "./channel-monitor.js";
import { startConfigDoctor, stopConfigDoctor } from "./config-doctor.js";
import { stopMemoryWatcher } from "../memory-watcher.js";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_VERSION: string = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")
  ) as { version: string }
).version;

let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;

// Pulse backoff state
let pulseFailureCount = 0;
const PULSE_FAILURE_THRESHOLD = 3; // Start backoff after N consecutive failures
const PULSE_MAX_INTERVAL_MS = 3_600_000; // 60 min cap

// Config change detection is now handled by config-monitor.ts

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

  const basePulseIntervalMs = config.pulseIntervalMs ?? 300_000;

  // Reset pulse backoff state
  pulseFailureCount = 0;

  // Initialize config monitor snapshot (baseline — no events emitted)
  resetSnapshot();
  initSnapshot(api.config ?? {});

  // Send initial pulse right now
  void sendPulseWithBackoff(endpoint, apiKey, basePulseIntervalMs, api);

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

  // Start auth profile health monitoring (every 15 min)
  startAuthMonitor(900_000, undefined, endpoint, apiKey);

  // Start channel connectivity monitoring (every 5 min)
  startChannelMonitor(300_000, undefined, endpoint, apiKey);

  // Start config health doctor (every 15 min)
  startConfigDoctor(900_000, undefined, endpoint, apiKey);

  api.logger.info(
    `[podwatch/lifecycle] Pulse & scan started from register(). Pulse: ${config.pulseIntervalMs ?? 300_000}ms, Scan: ${config.scanIntervalMs ?? 21_600_000}ms`
  );

  // -----------------------------------------------------------------------
  // gateway_start — best-effort re-scan (in case it ever fires)
  // -----------------------------------------------------------------------
  api.on(
    "gateway_start",
    async (event: GatewayStartEvent): Promise<void> => {
      try {
        // Check config changes on gateway restart (config may have changed)
        if (api.config) {
          checkConfigChanges(api.config);
        }
        // Re-run scan as best-effort; pulse is already running
        void runScan(api.config?.agents?.defaults?.workspace);
      } catch (err) {
        try { console.error("[podwatch/lifecycle] gateway_start handler error:", err); } catch {}
      }
    },
    { name: "podwatch-gateway-start" }
  );

  // -----------------------------------------------------------------------
  // gateway_stop — graceful shutdown
  // -----------------------------------------------------------------------
  api.on(
    "gateway_stop",
    async (): Promise<void> => {
      try {
        // Stop intervals
        if (pulseTimer) {
          clearTimeout(pulseTimer);
          pulseTimer = null;
        }
        if (scanTimer) {
          clearInterval(scanTimer);
          scanTimer = null;
        }

        // Stop auth health monitor
        stopAuthMonitor();

        // Stop channel health monitor
        stopChannelMonitor();

        // Stop memory file watcher
        stopMemoryWatcher();

        // Unsubscribe from diagnostic events
        const unsubscribe = (api as any).__podwatch_unsubscribeDiagnostics;
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }

        // Flush remaining events
        await transmitter.shutdown();

        api.logger.info("[podwatch/lifecycle] Graceful shutdown complete");
      } catch (err) {
        try { console.error("[podwatch/lifecycle] gateway_stop handler error:", err); } catch {}
      }
    },
    { name: "podwatch-gateway-stop" }
  );

  // -----------------------------------------------------------------------
  // before_compaction — context window pressure
  // -----------------------------------------------------------------------
  api.on(
    "before_compaction",
    async (event: BeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void> => {
      try {
        if (!event || typeof event !== "object") return;
        const safeCtx = (ctx && typeof ctx === "object") ? ctx : {} as PluginHookAgentContext;

        const tokenCount = typeof event.tokenCount === "number" ? event.tokenCount : undefined;
        const contextLimit = typeof (event as any).contextLimit === "number"
          ? (event as any).contextLimit as number
          : undefined;
        const contextPercent = (typeof tokenCount === "number" && typeof contextLimit === "number" && contextLimit > 0)
          ? Math.round((tokenCount / contextLimit) * 100)
          : undefined;
        const trigger = typeof (event as any).trigger === "string"
          ? (event as any).trigger
          : undefined;

        transmitter.enqueue({
          type: "compaction",
          ts: Date.now(),
          messageCount: typeof event.messageCount === "number" ? event.messageCount : 0,
          tokenCount,
          contextLimit,
          contextPercent,
          trigger,
          sessionKey: safeCtx.sessionKey,
          agentId: safeCtx.agentId,
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
              sessionKey: safeCtx.sessionKey,
              agentId: safeCtx.agentId,
            });
          }
        }
      } catch (err) {
        try { console.error("[podwatch/lifecycle] before_compaction handler error:", err); } catch {}
      }
    },
    { name: "podwatch-compaction" }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a lightweight pulse directly to the Podwatch API, then schedule
 * the next pulse. Uses exponential backoff after consecutive failures.
 *
 * Backoff kicks in after PULSE_FAILURE_THRESHOLD (3) consecutive failures:
 *   base → 2x base → 4x base → ... capped at PULSE_MAX_INTERVAL_MS (60min)
 * Resets to base interval on success.
 */
async function sendPulseWithBackoff(
  endpoint: string,
  apiKey: string,
  baseIntervalMs: number,
  api?: any,
): Promise<void> {
  // Check for config changes on each pulse
  if (api?.config) {
    checkConfigChanges(api.config);
  }
  let success = false;
  try {
    // Build enriched pulse payload
    const pulsePayload: Record<string, unknown> = {
      ts: Date.now(),
      bufferedEvents: transmitter.bufferedCount,
      uptimeHours: transmitter.getAgentUptimeHours(),
      pluginVersion: PLUGIN_VERSION,
    };

    // Enrich with system/context info — wrapped in try/catch so failures don't break pulse
    try {
      pulsePayload.nodeVersion = process.version;
      pulsePayload.platform = process.platform;
    } catch { /* safe to ignore */ }

    try {
      // Context window info from diagnostic events or config
      const contextLimit = api?.config?.agents?.defaults?.contextTokens
        ?? api?.config?.agents?.defaults?.maxContextTokens;
      if (typeof contextLimit === "number") {
        pulsePayload.contextLimit = contextLimit;
      }
    } catch { /* safe to ignore */ }

    try {
      // Active sessions count — check if runtime info is available
      const activeSessions = api?.runtime?.activeSessions
        ?? api?.runtime?.sessionCount;
      if (typeof activeSessions === "number") {
        pulsePayload.activeSessions = activeSessions;
      }
    } catch { /* safe to ignore */ }

    const response = await fetch(`${endpoint}/pulse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(pulsePayload),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      success = true;
    } else {
      console.error(`[podwatch/pulse] API ${response.status}`);
    }
  } catch (err) {
    console.error("[podwatch/pulse] Failed:", err);
  }

  // Update failure counter
  if (success) {
    pulseFailureCount = 0;
  } else {
    pulseFailureCount++;
  }

  // Calculate next interval
  let nextIntervalMs = baseIntervalMs;
  if (pulseFailureCount >= PULSE_FAILURE_THRESHOLD) {
    // Exponential backoff: 2x base per failure beyond threshold
    const backoffMultiplier = Math.pow(2, pulseFailureCount - PULSE_FAILURE_THRESHOLD);
    nextIntervalMs = Math.min(baseIntervalMs * 2 * backoffMultiplier, PULSE_MAX_INTERVAL_MS);
  }

  // Schedule next pulse
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(
    () => void sendPulseWithBackoff(endpoint, apiKey, baseIntervalMs, api),
    nextIntervalMs,
  );
  if (pulseTimer && typeof pulseTimer === "object" && "unref" in pulseTimer) {
    pulseTimer.unref();
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
