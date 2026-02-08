/**
 * Podwatch Plugin — OpenClaw cost monitoring, budget enforcement, and security alerts.
 *
 * Registers hook handlers and subscribes to diagnostic events to capture:
 * - Cost/token data per LLM call (onDiagnosticEvent → model.usage)
 * - Tool security scanning + budget blocking (before_tool_call)
 * - Tool latency + success/failure (after_tool_call)
 * - Session lifecycle (session_start, session_end)
 * - Context pressure (before_compaction)
 * - Heartbeat + skill/plugin scanning (gateway_start)
 * - Graceful shutdown (gateway_stop)
 */

import type { PluginHookName } from "./types.js";
import { registerCostHandler } from "./hooks/cost.js";
import { registerSecurityHandlers } from "./hooks/security.js";
import { registerSessionHandlers } from "./hooks/sessions.js";
import { registerLifecycleHandlers } from "./hooks/lifecycle.js";
import { transmitter } from "./transmitter.js";

// ---------------------------------------------------------------------------
// Plugin config interface
// ---------------------------------------------------------------------------

export interface PodwatchConfig {
  apiKey: string;
  endpoint?: string;
  enableBudgetEnforcement?: boolean;
  enableSecurityAlerts?: boolean;
  heartbeatIntervalMs?: number;
  scanIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * OpenClaw plugin entry point.
 * Called by the Gateway when the plugin is loaded.
 */
export default function register(api: any): void {
  const config = resolveConfig(api);

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
    flushIntervalMs: 5_000,
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

  api.logger.info(
    `[podwatch] Plugin loaded. Budget enforcement: ${config.enableBudgetEnforcement ? "ON" : "OFF"}, ` +
      `Security alerts: ${config.enableSecurityAlerts ? "ON" : "OFF"}, ` +
      `Diagnostics: ${diagnosticsEnabled ? "ON" : "OFF"}`
  );
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(api: any): PodwatchConfig {
  const pluginConfig = api.pluginConfig ?? {};

  return {
    apiKey: pluginConfig.apiKey ?? process.env.PODWATCH_API_KEY ?? "",
    endpoint: pluginConfig.endpoint ?? process.env.PODWATCH_ENDPOINT,
    enableBudgetEnforcement: pluginConfig.enableBudgetEnforcement ?? true,
    enableSecurityAlerts: pluginConfig.enableSecurityAlerts ?? true,
    heartbeatIntervalMs: pluginConfig.heartbeatIntervalMs ?? 60_000,
    scanIntervalMs: pluginConfig.scanIntervalMs ?? 21_600_000, // 6 hours
  };
}
