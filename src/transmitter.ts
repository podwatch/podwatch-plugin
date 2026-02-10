/**
 * Batched HTTP transmitter — queues events and flushes to Podwatch cloud.
 *
 * Features:
 * - Configurable batch size and flush interval
 * - Exponential backoff on failure
 * - Buffer overflow protection (drops SAFE events first)
 * - Graceful shutdown (flush on gateway_stop)
 * - Credential access tracking (for exfiltration detection)
 * - Known tool tracking (for first-time tool alerts)
 * - Cached budget state (synced every 60s from dashboard)
 * - Local audit log for dropped events
 * - 402 trial-expired handling
 */

import type { TransmitterConfig, PodwatchEvent } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: TransmitterConfig | null = null;
let buffer: PodwatchEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInProgress = false;
let retryBackoffMs = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_BUFFER_SIZE = 1_000;
const PLUGIN_VERSION = "0.1.0";

// --- Trial expired flag ---
let trialExpired = false;

// --- Credential access tracking ---
interface CredentialAccess {
  toolName: string;
  path: string;
  ts: number;
}

const recentCredentialAccesses: CredentialAccess[] = [];
const CREDENTIAL_ACCESS_WINDOW_MS = 60_000; // 60 seconds

// --- Known tools tracking ---
const knownTools = new Set<string>();
let activateTs = 0; // when the plugin started

// --- Budget cache ---
interface CachedBudget {
  limit: number;
  currentSpend: number;
  lastSyncTs: number;
}

let cachedBudget: CachedBudget | null = null;
let budgetSyncTimer: ReturnType<typeof setInterval> | null = null;
const BUDGET_SYNC_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Audit log for dropped events
// ---------------------------------------------------------------------------

function getAuditLogPath(): string {
  return path.join(os.homedir(), ".openclaw", "extensions", "podwatch", "audit.log");
}

function writeAuditLog(reason: string, eventCount: number, events: PodwatchEvent[]): void {
  try {
    const logDir = path.dirname(getAuditLogPath());
    fs.mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      eventCount,
      eventTypes: events.map((e) => e.type),
    });
    fs.appendFileSync(getAuditLogPath(), entry + "\n");
  } catch {
    // Best-effort — don't crash the plugin over audit logging
  }
}

// ---------------------------------------------------------------------------
// HTTP flush
// ---------------------------------------------------------------------------

/**
 * Map internal event type to a resultStatus string that the dashboard API expects.
 */
function mapResultStatus(event: PodwatchEvent): string {
  switch (event.type) {
    case "tool_call":
      return "invoked";
    case "tool_result":
      return event.success === false ? "error" : "success";
    case "cost":
      return "usage";
    case "security":
      return "alert";
    case "budget_blocked":
      return "blocked";
    case "session_start":
      return "session_start";
    case "session_end":
      return "session_end";
    case "heartbeat":
      return "heartbeat";
    case "compaction":
      return "compaction";
    case "scan":
      return "scan";
    case "setup_warning":
      return "warning";
    case "alert":
      return "alert";
    default:
      return event.type || "unknown";
  }
}

/**
 * Build a human-readable description from the internal event fields.
 */
function buildDescription(event: PodwatchEvent): string {
  const parts: string[] = [];

  switch (event.type) {
    case "tool_call": {
      const name = event.toolName ? String(event.toolName) : "unknown_tool";
      parts.push(`Called: ${name}`);
      break;
    }
    case "tool_result": {
      const name = event.toolName ? String(event.toolName) : "unknown_tool";
      const status = event.success === false ? "error" : "success";
      parts.push(`${name}: ${status}`);
      if (event.error) parts.push(String(event.error).slice(0, 200));
      break;
    }
    case "cost": {
      const model = event.model ? String(event.model) : "unknown_model";
      const cost = typeof event.costUsd === "number" ? `$${event.costUsd.toFixed(4)}` : "$?";
      const tokens = typeof event.totalTokens === "number" ? `${event.totalTokens} tokens` : "? tokens";
      parts.push(`${model}: ${cost} (${tokens})`);
      break;
    }
    case "security": {
      if (event.pattern) parts.push(String(event.pattern));
      if (event.severity) parts.push(`severity=${event.severity}`);
      if (event.reason) parts.push(String(event.reason));
      break;
    }
    case "session_start": {
      parts.push("Session started");
      if (event.sessionId) parts.push(`id=${event.sessionId}`);
      break;
    }
    case "session_end": {
      parts.push("Session ended");
      if (event.sessionId) parts.push(`id=${event.sessionId}`);
      if (typeof event.durationMs === "number") parts.push(`duration=${Math.round(Number(event.durationMs) / 1000)}s`);
      break;
    }
    default: {
      if (event.type) parts.push(String(event.type));
      if (event.toolName) parts.push(String(event.toolName));
      if (event.pattern) parts.push(String(event.pattern));
      if (event.severity) parts.push(`severity=${event.severity}`);
      if (event.reason) parts.push(String(event.reason));
      if (event.message) parts.push(String(event.message));
      if (event.error) parts.push(`error: ${String(event.error).slice(0, 200)}`);
      if (event.loopDetected) parts.push(`loop_detected (${event.messagesPerMinute} msg/min)`);
      break;
    }
  }

  const desc = parts.join(": ");
  return desc.slice(0, 2000);
}

/**
 * Determine sessionType from the internal event.
 * If the event already carries an explicit sessionType (e.g. set by cost handler
 * for heartbeat-triggered LLM calls), use it directly.
 */
function mapSessionType(event: PodwatchEvent): "interactive" | "heartbeat" | "cron" | "unknown" {
  // Allow upstream hooks to pre-set sessionType (e.g. heartbeat cost events)
  if (typeof event.sessionType === "string" && event.sessionType) {
    return event.sessionType as "interactive" | "heartbeat" | "cron" | "unknown";
  }
  if (event.type === "heartbeat") return "heartbeat";
  if (event.type === "scan") return "cron";
  // Tool calls, tool results, cost, security, session events = interactive
  if (event.type === "tool_call" || event.type === "tool_result" || event.type === "cost" ||
      event.type === "security" || event.type === "budget_blocked" ||
      event.type === "session_start" || event.type === "session_end" ||
      event.type === "compaction" || event.type === "alert") return "interactive";
  return "unknown";
}

/**
 * Extract agentId from a sessionKey string.
 * SessionKey format: "agent:<agentId>:<sessionType>:..."
 */
function extractAgentIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey || typeof sessionKey !== "string") return undefined;
  const parts = sessionKey.split(":");
  // Format: agent:<agentId>:<rest...>
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1] || undefined;
  }
  return undefined;
}

/**
 * Resolve agentId with fallback chain:
 * 1. event.agentId (if present)
 * 2. Extract from event.sessionKey
 * 3. Default to "main"
 */
function resolveAgentId(event: PodwatchEvent): string {
  if (event.agentId != null && String(event.agentId).length > 0) {
    return String(event.agentId);
  }
  const sessionKey = (event.sessionKey ?? event.sessionId) as string | undefined;
  if (sessionKey) {
    const extracted = extractAgentIdFromSessionKey(sessionKey);
    if (extracted) return extracted;
  }
  return "main";
}

/**
 * Resolve sessionId with fallback chain:
 * 1. event.sessionKey (if present)
 * 2. event.sessionId
 * 3. Default to "default"
 */
function resolveSessionId(event: PodwatchEvent): string {
  if (event.sessionKey != null && String(event.sessionKey).length > 0) {
    return String(event.sessionKey);
  }
  if (event.sessionId != null && String(event.sessionId).length > 0) {
    return String(event.sessionId);
  }
  return "default";
}

/**
 * Resolve toolName — for cost events, use the model name instead of generic "cost".
 */
function resolveToolName(event: PodwatchEvent): string {
  if (event.type === "cost" && typeof event.model === "string" && event.model) {
    return event.model;
  }
  return (typeof event.toolName === "string" && event.toolName) || event.type as string || "system";
}

/**
 * Transform internal PodwatchEvent[] into the API-expected EventPayload[].
 */
function transformEvents(events: PodwatchEvent[]): Record<string, unknown>[] {
  return events.map((event) => {
    const transformed: Record<string, unknown> = {
      eventId: typeof event.eventId === "string" ? event.eventId : crypto.randomUUID(),
      timestamp: new Date(event.ts).toISOString(),
      toolName: resolveToolName(event),
      resultStatus: mapResultStatus(event),
      description: buildDescription(event),
      sessionType: mapSessionType(event),
      agentId: resolveAgentId(event),
      sessionId: resolveSessionId(event),
    };

    // Optional fields — only include if present
    if (event.model != null) transformed.model = String(event.model);
    if (typeof event.inputTokens === "number") transformed.inputTokens = event.inputTokens;
    if (typeof event.outputTokens === "number") transformed.outputTokens = event.outputTokens;
    if (typeof event.cacheReadTokens === "number") transformed.cacheReadTokens = event.cacheReadTokens;
    if (typeof event.cacheWriteTokens === "number") transformed.cacheWriteTokens = event.cacheWriteTokens;
    if (typeof event.durationMs === "number") transformed.durationMs = event.durationMs;
    if (event.params != null) transformed.toolArgs = event.params;
    if (typeof event.redactedCount === "number") transformed.redactedCount = event.redactedCount;

    return transformed;
  });
}

async function sendBatch(events: PodwatchEvent[]): Promise<boolean> {
  if (!config) return false;

  const payload = {
    events: transformEvents(events),
    skillVersion: PLUGIN_VERSION,
  };

  try {
    const response = await fetch(`${config.endpoint}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      retryBackoffMs = 1_000;
      return true;
    }

    // 402 — trial expired, disable all future transmissions
    if (response.status === 402) {
      trialExpired = true;
      console.warn(
        "[podwatch] Trial expired (402) — event transmission disabled. Visit podwatch.app to upgrade."
      );
      return true; // consume the batch (don't retry)
    }

    // Other 4xx — client error, drop events + audit log
    if (response.status >= 400 && response.status < 500) {
      console.error(`[podwatch] API ${response.status}: dropping ${events.length} events`);
      writeAuditLog(`http_${response.status}`, events.length, events);
      retryBackoffMs = 1_000;
      return true; // Don't retry client errors
    }

    console.error(`[podwatch] API ${response.status}: will retry ${events.length} events`);
    return false;
  } catch (err) {
    console.error("[podwatch] Network error during flush:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core flush
// ---------------------------------------------------------------------------

async function doFlush(): Promise<void> {
  if (flushInProgress || buffer.length === 0 || !config) return;

  // Trial expired — silently discard all buffered events
  if (trialExpired) {
    buffer.length = 0;
    return;
  }

  flushInProgress = true;

  try {
    const batchSize = Math.min(buffer.length, config.batchSize);
    const batch = buffer.slice(0, batchSize);

    const success = await sendBatch(batch);

    if (success) {
      buffer.splice(0, batchSize);
      retryBackoffMs = 1_000;
    } else {
      // Write audit log if we've hit max retries (backoff maxed out)
      if (retryBackoffMs >= MAX_BACKOFF_MS) {
        writeAuditLog("max_retries_exceeded", batch.length, batch);
        buffer.splice(0, batchSize); // drop after max retries
      } else {
        setTimeout(() => void doFlush(), retryBackoffMs);
        retryBackoffMs = Math.min(retryBackoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  } catch (err) {
    console.error("[podwatch] Unexpected flush error:", err);
  } finally {
    flushInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Budget sync
// ---------------------------------------------------------------------------

/**
 * Budget sync is currently disabled — the dashboard API does not yet expose
 * a /api/budget endpoint (returns 404). Budget enforcement will use locally
 * cached state only. TODO: Re-enable once the dashboard ships the budget API.
 */
async function syncBudget(): Promise<void> {
  // No-op: /api/budget endpoint not available yet.
  // When the endpoint is ready, restore the fetch call here.
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const transmitter = {
  start(cfg: TransmitterConfig): void {
    config = cfg;
    buffer = [];
    retryBackoffMs = 1_000;
    flushInProgress = false;
    trialExpired = false;
    activateTs = Date.now();
    knownTools.clear();
    recentCredentialAccesses.length = 0;
    cachedBudget = null;

    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => void doFlush(), config.flushIntervalMs);
    if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
      flushTimer.unref();
    }

    // Start budget sync
    void syncBudget();
    if (budgetSyncTimer) clearInterval(budgetSyncTimer);
    budgetSyncTimer = setInterval(() => void syncBudget(), BUDGET_SYNC_INTERVAL_MS);
    if (budgetSyncTimer && typeof budgetSyncTimer === "object" && "unref" in budgetSyncTimer) {
      budgetSyncTimer.unref();
    }
  },

  enqueue(event: PodwatchEvent): void {
    buffer.push(event);

    // Overflow protection — drop oldest non-critical events
    if (buffer.length > MAX_BUFFER_SIZE) {
      const idx = buffer.findIndex(
        (e) =>
          e.type !== "setup_warning" &&
          e.type !== "security" &&
          e.type !== "budget_blocked"
      );
      if (idx >= 0) {
        buffer.splice(idx, 1);
        console.warn("[podwatch] Buffer overflow: dropped 1 event");
      }
    }

    // Flush if batch size reached
    if (config && buffer.length >= config.batchSize) {
      void doFlush();
    }
  },

  async flush(): Promise<void> {
    await doFlush();
  },

  stop(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (budgetSyncTimer) {
      clearInterval(budgetSyncTimer);
      budgetSyncTimer = null;
    }
  },

  /** Flush remaining events and stop. For graceful shutdown. */
  async shutdown(): Promise<void> {
    while (buffer.length > 0 && config) {
      await doFlush();
    }
    this.stop();
  },

  // -----------------------------------------------------------------------
  // Credential access tracking (exfiltration detection)
  // -----------------------------------------------------------------------

  /** Mark that a tool accessed credentials. */
  markCredentialAccess(toolName: string, params: Record<string, unknown>): void {
    const path =
      (typeof params.path === "string" && params.path) ||
      (typeof params.file_path === "string" && params.file_path) ||
      (typeof params.command === "string" && params.command) ||
      "unknown";

    recentCredentialAccesses.push({
      toolName,
      path,
      ts: Date.now(),
    });

    // Prune old entries
    this._pruneCredentialAccesses();
  },

  /** Check if there was a credential access within the last `windowSec` seconds. */
  hasRecentCredentialAccess(windowSec: number): boolean {
    this._pruneCredentialAccesses();
    const cutoff = Date.now() - windowSec * 1_000;
    return recentCredentialAccesses.some((a) => a.ts >= cutoff);
  },

  /** Get the most recent credential access details (for exfiltration alerts). */
  getRecentCredentialAccess(windowSec: number): CredentialAccess | null {
    this._pruneCredentialAccesses();
    const cutoff = Date.now() - windowSec * 1_000;
    const recent = recentCredentialAccesses.filter((a) => a.ts >= cutoff);
    return recent.length > 0 ? recent[recent.length - 1]! : null;
  },

  _pruneCredentialAccesses(): void {
    const cutoff = Date.now() - CREDENTIAL_ACCESS_WINDOW_MS;
    while (recentCredentialAccesses.length > 0 && recentCredentialAccesses[0]!.ts < cutoff) {
      recentCredentialAccesses.shift();
    }
  },

  // -----------------------------------------------------------------------
  // Known tool tracking (first-time tool detection)
  // -----------------------------------------------------------------------

  /** Check if a tool has been seen before. */
  isKnownTool(toolName: string): boolean {
    return knownTools.has(toolName);
  },

  /** Record a tool as seen. */
  recordToolSeen(toolName: string): void {
    knownTools.add(toolName);
  },

  /** Get agent uptime in hours since plugin activated. */
  getAgentUptimeHours(): number {
    if (activateTs === 0) return 0;
    return (Date.now() - activateTs) / (1_000 * 60 * 60);
  },

  // -----------------------------------------------------------------------
  // Budget cache
  // -----------------------------------------------------------------------

  /** Get cached budget state (synced from dashboard every 60s). */
  getCachedBudget(): CachedBudget | null {
    return cachedBudget;
  },

  /** Force a budget sync now. */
  async forceBudgetSync(): Promise<void> {
    await syncBudget();
  },

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /** Current buffer size (for testing/diagnostics). */
  get bufferedCount(): number {
    return buffer.length;
  },

  /** Number of known tools (for testing/diagnostics). */
  get knownToolCount(): number {
    return knownTools.size;
  },

  /** Whether trial has expired (for testing). */
  get isTrialExpired(): boolean {
    return trialExpired;
  },
};
