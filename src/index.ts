/**
 * Podwatch Plugin — OpenClaw cost monitoring, budget enforcement, and security alerts.
 *
 * Registers hook handlers and subscribes to diagnostic events to capture:
 * - Cost/token data per LLM call (onDiagnosticEvent → model.usage)
 * - Tool security scanning + budget blocking (before_tool_call)
 * - Tool latency + success/failure (after_tool_call)
 * - Session lifecycle (session_start, session_end)
 * - Context pressure (before_compaction)
 * - Pulse alive-ping + skill/plugin scanning (register())
 * - Graceful shutdown (gateway_stop)
 */

import type { PluginHookName, PluginApi } from "./types.js";
import { registerCostHandler } from "./hooks/cost.js";
import { registerSecurityHandlers } from "./hooks/security.js";
import { registerSessionHandlers } from "./hooks/sessions.js";
import { registerLifecycleHandlers } from "./hooks/lifecycle.js";
import { registerBudgetHooks } from "./hooks/budget.js";
import { transmitter } from "./transmitter.js";
import { scheduleUpdateCheck } from "./updater.js";
import { startMemoryWatcher } from "./memory-watcher.js";
import { recordActivity } from "./activity-tracker.js";

// ---------------------------------------------------------------------------
// Plugin config interface
// ---------------------------------------------------------------------------

export interface PodwatchConfig {
  apiKey: string;
  endpoint?: string;
  enableBudgetEnforcement?: boolean;
  enableSecurityAlerts?: boolean;
  /** Enable auto-update of the plugin. Default: false (opt-in for security). */
  autoUpdate?: boolean;
  /** Pulse alive-ping interval in ms (default 300000 = 5 min). */
  pulseIntervalMs?: number;
  /** @deprecated Use pulseIntervalMs instead. Kept for backward compatibility. */
  heartbeatIntervalMs?: number;
  scanIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/** Check debug mode at runtime so tests can toggle PODWATCH_DEBUG after module load. */
function isDebug(): boolean {
  return !!process.env.PODWATCH_DEBUG;
}

/**
 * Redact sensitive fields from an object for safe debug logging.
 * Returns a shallow copy with secret values replaced by '***'.
 */
function redactForLog(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const SENSITIVE_KEYS = ["apiKey", "apiSecret", "secret", "token", "password", "key"];
  const redacted: Record<string, unknown> = { ...obj };
  for (const k of SENSITIVE_KEYS) {
    if (k in redacted && redacted[k]) {
      redacted[k] = "***";
    }
  }
  return redacted;
}

/**
 * OpenClaw plugin entry point.
 * Called by the Gateway when the plugin is loaded.
 */
export default function register(api: PluginApi): void {
  if (isDebug()) {
    console.log("[podwatch:debug] register() called");
    console.log("[podwatch:debug] api object keys:", Object.keys(api));
    // Log only safe gateway config fields — never dump the full api.config
    const safeConfigKeys = api.config
      ? { diagnostics: api.config.diagnostics, agents: api.config.agents ? "(present)" : "(absent)" }
      : "(undefined)";
    console.log("[podwatch:debug] api.config (safe fields):", JSON.stringify(safeConfigKeys, null, 2));
    console.log("[podwatch:debug] api.pluginConfig:", JSON.stringify(redactForLog(api.pluginConfig ?? {}), null, 2));
    console.log("[podwatch:debug] api.runtime keys:", api.runtime ? Object.keys(api.runtime) : "undefined");
  }

  const config = resolveConfig(api);
  if (isDebug()) {
    console.log("[podwatch:debug] Resolved config:", JSON.stringify(redactForLog(config as any), null, 2));
  }

  if (!config.apiKey) {
    api.logger.error(
      "[podwatch] No API key configured. Set it in plugins.entries.podwatch.config.apiKey"
    );
    return;
  }

  // Start the transmitter (batched HTTP to Podwatch cloud)
  transmitter.start({
    apiKey: config.apiKey,
    endpoint: config.endpoint ?? "https://podwatch.app/api",
    batchSize: 50,
    flushIntervalMs: 30_000,
  });

  // Check if diagnostics are enabled
  const diagnosticsEnabled = api.config?.diagnostics?.enabled === true;
  if (!diagnosticsEnabled) {
    api.logger.warn(
      "[podwatch] diagnostics.enabled is not set to true in gateway config. " +
        "Cost tracking will not work. Enable it: diagnostics: { enabled: true }"
    );
    // POST setup warning to dashboard
    transmitter.enqueue({
      type: "setup_warning",
      message: "Enable diagnostics for cost tracking: set diagnostics.enabled: true in openclaw.json",
      ts: Date.now(),
    });
  }

  // Register all hook handlers
  registerCostHandler(api, config, diagnosticsEnabled);
  registerSecurityHandlers(api, config);
  registerSessionHandlers(api);
  registerLifecycleHandlers(api, config);
  registerBudgetHooks(api, config);

  // Track agent activity for graceful restart deferral.
  // These lightweight calls update a singleton timestamp — no I/O, no throwing.
  api.on("before_agent_start", () => { recordActivity(); });
  api.on("before_tool_call", () => { recordActivity(); });
  api.on("message_received", () => { recordActivity(); });
  api.on("session_start", () => { recordActivity(); });

  // Schedule non-blocking auto-update check (30s after boot, 24h cooldown)
  // Auto-update is opt-in (default false) for supply chain security.
  const currentVersion = api.version ?? "0.0.0";
  const endpoint = config.endpoint ?? "https://podwatch.app/api";
  scheduleUpdateCheck(currentVersion, endpoint, api.logger, { autoUpdate: config.autoUpdate });

  // Start memory file watcher (non-blocking)
  const workspaceDir = api.config?.agents?.defaults?.workspace;
  if (workspaceDir) {
    startMemoryWatcher(workspaceDir, endpoint, config.apiKey);
  } else {
    api.logger.warn("[podwatch] No workspace directory configured — memory watcher disabled");
  }

  api.logger.info(
    `[podwatch] Plugin loaded (v${currentVersion}). Budget enforcement: ${config.enableBudgetEnforcement ? "ON" : "OFF"}, ` +
      `Security alerts: ${config.enableSecurityAlerts ? "ON" : "OFF"}, ` +
      `Diagnostics: ${diagnosticsEnabled ? "ON" : "OFF"}`
  );
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(api: PluginApi): PodwatchConfig {
  const pluginConfig = api.pluginConfig ?? {};
  if (isDebug()) {
    console.log("[podwatch:debug] resolveConfig() — raw pluginConfig:", JSON.stringify(redactForLog(pluginConfig), null, 2));
    console.log("[podwatch:debug] resolveConfig() — env PODWATCH_API_KEY set:", !!process.env.PODWATCH_API_KEY);
    console.log("[podwatch:debug] resolveConfig() — env PODWATCH_ENDPOINT:", process.env.PODWATCH_ENDPOINT ?? "(unset)");
  }

  return {
    apiKey: pluginConfig.apiKey ?? process.env.PODWATCH_API_KEY ?? "",
    endpoint: pluginConfig.endpoint ?? process.env.PODWATCH_ENDPOINT,
    enableBudgetEnforcement: pluginConfig.enableBudgetEnforcement ?? true,
    enableSecurityAlerts: pluginConfig.enableSecurityAlerts ?? true,
    autoUpdate: pluginConfig.autoUpdate ?? true,
    // Backward compat: fall back to heartbeatIntervalMs if pulseIntervalMs not set
    pulseIntervalMs: pluginConfig.pulseIntervalMs ?? pluginConfig.heartbeatIntervalMs ?? 300_000,
    scanIntervalMs: pluginConfig.scanIntervalMs ?? 21_600_000, // 6 hours
  };
}
