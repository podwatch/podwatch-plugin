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

// Config change detection state
let knownPrimaryModel: string | null = null;

/**
 * Read the primary model from the OpenClaw gateway config.
 * Handles both string and object shapes for `agents.defaults.model`.
 */
function readPrimaryModel(api: any): string | null {
  try {
    const modelCfg = api.config?.agents?.defaults?.model;
    if (!modelCfg) return null;
    if (typeof modelCfg === "string") return modelCfg;
    if (typeof modelCfg === "object" && modelCfg.primary) return String(modelCfg.primary);
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the primary model changed and emit a config_change event if so.
 */
function checkModelConfigChange(api: any): void {
  const currentModel = readPrimaryModel(api);
  if (currentModel === knownPrimaryModel) return;

  const previousValue = knownPrimaryModel;
  knownPrimaryModel = currentModel;

  // Don't emit on first read if null
  if (currentModel === null && previousValue === null) return;

  transmitter.enqueue({
    type: "config_change",
    ts: Date.now(),
    field: "model.primary",
    value: currentModel,
    previousValue,
    // Pass as params so they appear in toolArgs on the server
    params: {
      field: "model.primary",
      value: currentModel,
      previousValue,
    },
  });
}

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

  // Read initial primary model config and send config_change event
  knownPrimaryModel = null; // Reset on re-register
  checkModelConfigChange(api);

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

  api.logger.info(
    `[podwatch/lifecycle] Pulse & scan started from register(). Pulse: ${config.pulseIntervalMs ?? 300_000}ms, Scan: ${config.scanIntervalMs ?? 21_600_000}ms`
  );

  // -----------------------------------------------------------------------
  // gateway_start — best-effort re-scan (in case it ever fires)
  // -----------------------------------------------------------------------
  api.registerHook(
    "gateway_start",
    async (event: GatewayStartEvent): Promise<void> => {
      // Re-run scan as best-effort; pulse is already running
      void runScan(api.config?.agents?.defaults?.workspace);
    },
    { name: "podwatch-gateway-start" }
  );

  // -----------------------------------------------------------------------
  // gateway_stop — graceful shutdown
  // -----------------------------------------------------------------------
  api.registerHook(
    "gateway_stop",
    async (): Promise<void> => {
      // Stop intervals
      if (pulseTimer) {
        clearTimeout(pulseTimer);
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
    },
    { name: "podwatch-gateway-stop" }
  );

  // -----------------------------------------------------------------------
  // before_compaction — context window pressure
  // -----------------------------------------------------------------------
  api.registerHook(
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
  if (api) {
    checkModelConfigChange(api);
  }
  let success = false;
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
        pluginVersion: PLUGIN_VERSION,
      }),
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
