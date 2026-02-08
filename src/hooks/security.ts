/**
 * Security handlers — before_tool_call and after_tool_call.
 *
 * before_tool_call: THE critical hook. Can BLOCK tool execution.
 * - Budget enforcement (blocks when daily spend >= 95% of limit)
 * - Exfiltration sequence detection (credential read → network call within 60s)
 * - First-time tool alerting (new tool after 24h uptime)
 * - Security classification (risk level for all tool calls)
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
import { classify } from "../classifier.js";
import { redactParams } from "../redact.js";

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

      // --- B) Security classification ---
      const classification = classify(toolName, params);

      // --- B1) Credential access tracking ---
      if (classification.accessesCredentials) {
        transmitter.markCredentialAccess(toolName, params);
      }

      // --- B2) Exfiltration sequence detection ---
      // Credential read → network call within 60 seconds = critical alert
      if (classification.makesNetworkCall && transmitter.hasRecentCredentialAccess(60)) {
        const credAccess = transmitter.getRecentCredentialAccess(60);

        transmitter.enqueue({
          type: "security",
          ts: Date.now(),
          severity: "critical",
          pattern: "exfiltration_sequence",
          toolName,
          params: redactParams(params),
          triggerTool: credAccess?.toolName,
          triggerPath: credAccess?.path,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
      }

      // --- B3) Persistence attempt detection ---
      if (classification.persistenceAttempt) {
        transmitter.enqueue({
          type: "security",
          ts: Date.now(),
          severity: "high",
          pattern: "persistence_attempt",
          toolName,
          params: redactParams(params),
          reason: classification.reason,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
      }

      // --- B4) First-time tool detection ---
      // Only alert after 24h uptime to avoid noise during initial setup
      if (!transmitter.isKnownTool(toolName) && transmitter.getAgentUptimeHours() > 24) {
        transmitter.enqueue({
          type: "security",
          ts: Date.now(),
          severity: "medium",
          pattern: "first_time_tool",
          toolName,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
      }

      // Record tool as seen (even on first call)
      transmitter.recordToolSeen(toolName);

      // --- B5) General security alerts for risky tools ---
      if (classification.riskLevel === "DANGER") {
        transmitter.enqueue({
          type: "security",
          ts: Date.now(),
          severity: "high",
          pattern: "dangerous_operation",
          toolName,
          params: redactParams(params),
          reason: classification.reason,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });
      }

      // --- C) Log ALL tool calls for timeline ---
      transmitter.enqueue({
        type: "tool_call",
        ts: Date.now(),
        toolName,
        params: redactParams(params),
        riskLevel: classification.riskLevel,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    },
    { priority: 10 } // Run early to block before other plugins
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
    }
  );

  api.logger.info(
    `[podwatch/security] Handlers registered. Budget: ${config.enableBudgetEnforcement ? "ENFORCE" : "off"}, ` +
      `Security: ${config.enableSecurityAlerts ? "ON" : "off"}`
  );
}
