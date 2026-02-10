/**
 * Security handlers — before_tool_call and after_tool_call.
 *
 * before_tool_call: THE critical hook. Can BLOCK tool execution.
 * - Budget enforcement (blocks when daily spend >= 95% of limit)
 * - Tool call logging with redacted params (server classifies risk)
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

      // --- B) Log ALL tool calls for timeline (server classifies risk) ---
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
