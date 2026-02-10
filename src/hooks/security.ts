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
// Helper to truncate long fields for debug logging
function debugStringify(obj: any): string {
  const truncated = JSON.parse(JSON.stringify(obj, (key, value) => {
    if ((key === "result" || key === "output" || key === "content") && typeof value === "string" && value.length > 200) {
      return value.slice(0, 200) + `... [truncated, ${value.length} chars total]`;
    }
    return value;
  }));
  return JSON.stringify(truncated, null, 2);
}

export function registerSecurityHandlers(api: any, config: PodwatchConfig): void {
  console.log("[podwatch:debug] registerSecurityHandlers() called, config:", JSON.stringify(config, null, 2));
  // -----------------------------------------------------------------------
  // before_tool_call — security scan + budget enforcement + exfiltration
  // -----------------------------------------------------------------------
  api.on(
    "before_tool_call",
    async (
      event: BeforeToolCallEvent,
      ctx: PluginHookAgentContext
    ): Promise<BeforeToolCallResult | void> => {
      console.log("[podwatch:debug] === before_tool_call ===");
      console.log("[podwatch:debug] before_tool_call event:", debugStringify(event));
      console.log("[podwatch:debug] before_tool_call ctx:", JSON.stringify(ctx, null, 2));
      const { toolName, params } = event;
      console.log("[podwatch:debug] toolName:", toolName, "params keys:", params ? Object.keys(params) : "none");

      // --- A) Budget check (if enabled) — can BLOCK ---
      if (config.enableBudgetEnforcement) {
        const budget = transmitter.getCachedBudget();
        console.log("[podwatch:debug] Budget check — budget:", JSON.stringify(budget), "tolerance:", BUDGET_TOLERANCE);

        if (budget && budget.limit > 0 && budget.currentSpend >= budget.limit * BUDGET_TOLERANCE) {
          console.log("[podwatch:debug] BUDGET EXCEEDED — blocking tool call. spend:", budget.currentSpend, "limit:", budget.limit);
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
        } else {
          console.log("[podwatch:debug] Budget check passed (within tolerance)");
        }
      } else {
        console.log("[podwatch:debug] Budget enforcement disabled, skipping check");
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
      console.log("[podwatch:debug] === after_tool_call ===");
      console.log("[podwatch:debug] after_tool_call event:", debugStringify(event));
      console.log("[podwatch:debug] after_tool_call ctx:", JSON.stringify(ctx, null, 2));
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
