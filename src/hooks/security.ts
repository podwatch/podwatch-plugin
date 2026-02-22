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
 * - Latency tracking (duration + success/failure)
 * - Correlation with the original tool_call via correlationId
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

// Track correlation IDs per tool call — keyed by sessionKey + toolName + timestamp bucket
// This allows us to correlate tool_call, tool_result, and cost events
const correlationIdMap = new Map<string, string>();
const CORRELATION_WINDOW_MS = 60_000; // 60 second window to match events

/**
 * Generate a unique correlation ID.
 */
function generateCorrelationId(): string {
  return `corr_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Build a lookup key for the correlation map.
 */
function buildCorrelationKey(sessionKey: string | undefined, toolName: string): string {
  return `${sessionKey ?? "default"}:${toolName}`;
}

/**
 * Clean up old correlation entries to prevent memory leaks.
 */
function pruneCorrelationIds(): void {
  const cutoff = Date.now() - CORRELATION_WINDOW_MS;
  // The correlationIdMap doesn't store timestamps directly, so we rely on session_end
  // to clear entries. For now, just cap the map size.
  if (correlationIdMap.size > 10_000) {
    // Clear oldest 20% of entries
    const entriesToDelete = Math.floor(correlationIdMap.size * 0.2);
    let deleted = 0;
    for (const key of correlationIdMap.keys()) {
      correlationIdMap.delete(key);
      deleted++;
      if (deleted >= entriesToDelete) break;
    }
  }
}

/**
 * Register security hook handlers.
 */
export function registerSecurityHandlers(api: any, config: PodwatchConfig): void {
  // -----------------------------------------------------------------------
  // before_tool_call — security scan + budget enforcement + exfiltration
  // -----------------------------------------------------------------------
  api.registerHook(
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
      // Generate correlation ID to link tool_call → tool_result → cost
      const correlationId = generateCorrelationId();
      const corrKey = buildCorrelationKey(ctx.sessionKey, toolName);
      correlationIdMap.set(corrKey, correlationId);
      pruneCorrelationIds();

      const { result: redactedParams, redactedCount } = redactParams(params);
      transmitter.enqueue({
        type: "tool_call",
        ts: Date.now(),
        toolName,
        params: redactedParams,
        redactedCount,
        correlationId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    },
    { name: "podwatch-security-scan", priority: 10 }, // Run early to block before other plugins
  );

  // -----------------------------------------------------------------------
  // after_tool_call — latency + success/failure (fire-and-forget)
  // -----------------------------------------------------------------------
  api.registerHook(
    "after_tool_call",
    async (event: AfterToolCallEvent, ctx: PluginHookAgentContext): Promise<void> => {
      // Look up correlation ID from the map (set by before_tool_call)
      const corrKey = buildCorrelationKey(ctx.sessionKey, event.toolName);
      const correlationId = correlationIdMap.get(corrKey);

      transmitter.enqueue({
        type: "tool_result",
        ts: Date.now(),
        toolName: event.toolName,
        durationMs: event.durationMs,
        success: !event.error,
        error: event.error ? String(event.error).slice(0, 500) : undefined,
        correlationId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
      });
    },
    { name: "podwatch-tool-result" },
  );

  api.logger.info(
    `[podwatch/security] Handlers registered. Budget: ${config.enableBudgetEnforcement ? "ENFORCE" : "off"}, ` +
      `Security: ${config.enableSecurityAlerts ? "ON" : "off"}`
  );

  // Cleanup correlation IDs on session end to prevent memory leaks
  api.registerHook("session_end", async (_event: unknown, ctx: PluginHookAgentContext) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;

    // Remove all correlation IDs for this session
    for (const key of correlationIdMap.keys()) {
      if (key.startsWith(`${sessionKey}:`)) {
        correlationIdMap.delete(key);
      }
    }
  }, { name: "podwatch-security-cleanup" });
}

