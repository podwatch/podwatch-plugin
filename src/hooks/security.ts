/**
 * Security handlers — before_tool_call and after_tool_call.
 *
 * before_tool_call: THE critical hook. Can BLOCK tool execution.
 * - A)  Budget enforcement (blocks when daily spend >= 95% of limit)
 * - B1) Exfiltration sequence detection (credential read → network call)
 * - B2) First-time tool detection (unknown tool after 24h uptime)
 * - B3) Log ALL tool calls with redacted params (server classifies risk)
 *
 * after_tool_call: Fire-and-forget.
 * - Latency tracking (durationMs)
 * - Success/failure recording
 */

import type { PodwatchConfig } from "../index.js";
import type {
  BeforeToolCallEvent,
  BeforeToolCallResult,
  AfterToolCallEvent,
  PluginHookAgentContext,
} from "../types.js";
import { transmitter } from "../transmitter.js";
import { redactParams } from "../redact.js";
import { classifyTool } from "../classifier.js";

const BUDGET_TOLERANCE = 0.95; // Block at 95% of limit

/**
 * Register security hook handlers.
 */
export function registerSecurityHandlers(api: any, config: PodwatchConfig): void {
  // -----------------------------------------------------------------------
  // before_tool_call — security scan + budget enforcement + exfiltration
  // -----------------------------------------------------------------------
  api.on(
    "before_tool_call",
    async (
      event: BeforeToolCallEvent,
      ctx: PluginHookAgentContext
    ): Promise<BeforeToolCallResult | void> => {
      const { toolName, params } = event;

      // --- A) Budget check (if enabled) — can BLOCK ---
      if (config.enableBudgetEnforcement) {
        const budget = transmitter.getCachedBudget();

        if (budget && budget.limit > 0 && budget.currentSpend >= budget.limit * BUDGET_TOLERANCE) {
          transmitter.enqueue({
            type: "budget_blocked",
            ts: Date.now(),
            toolName,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            budgetLimit: budget.limit,
            currentSpend: budget.currentSpend,
          });

          return {
            block: true,
            blockReason: `Podwatch: Daily budget of $${budget.limit.toFixed(2)} reached ($${budget.currentSpend.toFixed(2)} spent). Manage at podwatch.app/settings`,
          };
        }
      }

      // --- B) Security alerts (if enabled) ---
      if (config.enableSecurityAlerts) {
        const classification = classifyTool(toolName, params);

        // B1) Exfiltration sequence detection
        if (classification.accessesCredentials) {
          transmitter.markCredentialAccess(toolName, params);
        }

        if (classification.makesNetworkCall && transmitter.hasRecentCredentialAccess(60)) {
          const recentAccess = transmitter.getRecentCredentialAccess(60);
          transmitter.enqueue({
            type: "security",
            ts: Date.now(),
            pattern: "exfiltration_sequence",
            severity: "critical",
            toolName,
            reason: `Network call (${toolName}) detected within 60s of credential access (${recentAccess?.toolName ?? "unknown"} → ${recentAccess?.path ?? "unknown"})`,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        }

        // B1b) Persistence attempt detection
        if (classification.persistenceAttempt) {
          transmitter.enqueue({
            type: "security",
            ts: Date.now(),
            pattern: "persistence_attempt",
            severity: "high",
            toolName,
            reason: `Persistence attempt detected via ${toolName}`,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        }

        // B2) First-time tool detection
        if (!transmitter.isKnownTool(toolName) && transmitter.getAgentUptimeHours() > 24) {
          transmitter.enqueue({
            type: "security",
            ts: Date.now(),
            pattern: "first_time_tool",
            severity: "medium",
            toolName,
            reason: `First use of tool "${toolName}" after ${Math.round(transmitter.getAgentUptimeHours())}h uptime`,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        }
        transmitter.recordToolSeen(toolName);
      }

      // --- B3) Log ALL tool calls for timeline (server classifies risk) ---
      const { result: redactedParams, redactedCount } = redactParams(params);
      transmitter.enqueue({
        type: "tool_call",
        ts: Date.now(),
        toolName,
        params: redactedParams,
        redactedCount,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    },
    { name: "podwatch-security-scan", priority: 10 } // Run early to block before other plugins
  );

  // -----------------------------------------------------------------------
  // after_tool_call — latency + success/failure (fire-and-forget)
  // -----------------------------------------------------------------------
  api.on(
    "after_tool_call",
    async (event: AfterToolCallEvent, ctx: PluginHookAgentContext): Promise<void> => {
      transmitter.enqueue({
        type: "tool_result",
        ts: Date.now(),
        toolName: event.toolName,
        durationMs: event.durationMs,
        success: !event.error,
        error: event.error ? String(event.error).slice(0, 500) : undefined,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    },
    { name: "podwatch-tool-result" }
  );

  api.logger.info(
    `[podwatch/security] Handlers registered. Budget: ${config.enableBudgetEnforcement ? "ENFORCE" : "off"}, ` +
      `Security: ${config.enableSecurityAlerts ? "ON" : "off"}`
  );
}
