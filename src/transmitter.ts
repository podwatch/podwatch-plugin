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
 */

import type { TransmitterConfig, PodwatchEvent } from "./types.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: TransmitterConfig | null = null;
let buffer: PodwatchEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInProgress = false;
let retryBackoffMs = 1_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_BUFFER_SIZE = 1_000;
const PLUGIN_VERSION = "0.1.0";

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
    default:
      return event.type || "unknown";
  }
}

/**
 * Build a human-readable description from the internal event fields.
 */
function buildDescription(event: PodwatchEvent): string {
  const parts: string[] = [];

  if (event.type) parts.push(String(event.type));

  if (event.pattern) parts.push(String(event.pattern));
  if (event.severity) parts.push(`severity=${event.severity}`);
  if (event.reason) parts.push(String(event.reason));
  if (event.message) parts.push(String(event.message));
  if (event.error) parts.push(`error: ${String(event.error).slice(0, 200)}`);
  if (event.loopDetected) parts.push(`loop_detected (${event.messagesPerMinute} msg/min)`);
  if (event.riskLevel && event.riskLevel !== "SAFE") parts.push(`risk=${event.riskLevel}`);

  const desc = parts.join(": ");
  return desc.slice(0, 2000);
}

/**
 * Determine sessionType from the internal event.
 */
function mapSessionType(event: PodwatchEvent): "interactive" | "heartbeat" | "cron" | "unknown" {
  if (event.type === "heartbeat") return "heartbeat";
  // Could detect cron sessions from context in the future
  return "unknown";
}

/**
 * Transform internal PodwatchEvent[] into the API-expected EventPayload[].
 */
function transformEvents(events: PodwatchEvent[]): Record<string, unknown>[] {
  return events.map((event) => {
    const transformed: Record<string, unknown> = {
      eventId: typeof event.eventId === "string" ? event.eventId : crypto.randomUUID(),
      timestamp: new Date(event.ts).toISOString(),
      toolName: (typeof event.toolName === "string" && event.toolName) || event.type || "system",
      resultStatus: mapResultStatus(event),
      description: buildDescription(event),
      sessionType: mapSessionType(event),
    };

    // Optional fields — only include if present
    if (event.agentId != null) transformed.agentId = String(event.agentId);
    if (event.sessionKey != null) transformed.sessionId = String(event.sessionKey);
    else if (event.sessionId != null) transformed.sessionId = String(event.sessionId);
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

    if (response.status >= 400 && response.status < 500) {
      console.error(`[podwatch] API ${response.status}: dropping ${events.length} events`);
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

  flushInProgress = true;

  try {
    const batchSize = Math.min(buffer.length, config.batchSize);
    const batch = buffer.slice(0, batchSize);

    const success = await sendBatch(batch);

    if (success) {
      buffer.splice(0, batchSize);
      retryBackoffMs = 1_000;
    } else {
      setTimeout(() => void doFlush(), retryBackoffMs);
      retryBackoffMs = Math.min(retryBackoffMs * 2, MAX_BACKOFF_MS);
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
          e.riskLevel !== "DANGER" &&
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
};
