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
import { handleUrgentUpdate } from "./updater.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Read version from package.json at build time (resolveJsonModule enabled)
const PLUGIN_VERSION: string = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
  ) as { version: string }
).version;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: TransmitterConfig | null = null;
let buffer: PodwatchEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInProgress = false;
let retryBackoffMs = 1_000;
let retryCount = 0;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRIES = 10;
const MAX_BUFFER_SIZE = 1_000;
const BUFFER_TARGET_SIZE = 900;
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
const KNOWN_TOOLS_MAX_SIZE = 10_000;
let activateTs = 0; // when the plugin started

// --- Budget cache ---
interface CachedBudget {
  limit: number;
  currentSpend: number;
  lastSyncTs: number;
  hardStopEnabled: boolean;
  hardStopActive: boolean;
  dailySpend: number;
  dailyLimit: number;
  monthlySpend: number;
  monthlyLimit: number;
}

let cachedBudget: CachedBudget | null = null;
let budgetSyncTimer: ReturnType<typeof setInterval> | null = null;
const BUDGET_SYNC_INTERVAL_MS = 300_000; // 5 minutes — acceptable with 95% tolerance buffer

// ---------------------------------------------------------------------------
// Audit log for dropped events
// ---------------------------------------------------------------------------

function getAuditLogPath(): string {
  return path.join(os.homedir(), ".openclaw", "extensions", "podwatch", "audit.log");
}

const AUDIT_LOG_MAX_BYTES = 1_048_576; // 1 MB

function writeAuditLog(reason: string, eventCount: number, events: PodwatchEvent[]): void {
  try {
    const logPath = getAuditLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // Enforce size cap — rotate if at or over 1 MB
    try {
      const stats = fs.statSync(logPath);
      if (stats.size >= AUDIT_LOG_MAX_BYTES) {
        // Truncate: keep the last ~half of the file
        const content = fs.readFileSync(logPath, "utf-8");
        const half = Math.floor(content.length / 2);
        // Find the first newline after the midpoint to avoid partial lines
        const cutIdx = content.indexOf("\n", half);
        const trimmed = cutIdx >= 0 ? content.slice(cutIdx + 1) : "";
        fs.writeFileSync(logPath, trimmed, { mode: 0o600 });
      }
    } catch {
      // File may not exist yet — that's fine, appendFileSync will create it
    }

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      eventCount,
      eventTypes: events.map((e) => e.type),
    });
    fs.appendFileSync(logPath, entry + "\n", { mode: 0o600 });

    // Ensure file permissions are 0o600 (owner read/write only)
    fs.chmodSync(logPath, 0o600);
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
      if (event.resultPreview) parts.push(String(event.resultPreview));
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
    case "compaction": {
      const msgCount = typeof event.messageCount === "number" ? event.messageCount : 0;
      if (typeof event.contextPercent === "number") {
        parts.push(`Context: ${event.contextPercent}% → compacted (${msgCount.toLocaleString()} messages)`);
      } else {
        parts.push(`Compacted ${msgCount.toLocaleString()} messages`);
        if (typeof event.tokenCount === "number") parts.push(`${event.tokenCount.toLocaleString()} tokens`);
      }
      if (event.trigger) parts.push(`trigger=${event.trigger}`);
      break;
    }
    case "scan": {
      const totalSkills = typeof event.totalSkills === "number" ? event.totalSkills : 0;
      const totalPlugins = typeof event.totalPlugins === "number" ? event.totalPlugins : 0;
      parts.push(`Found ${totalSkills} skills, ${totalPlugins} plugins`);
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

    // Package enriched data for specific event types into toolArgs
    if (event.type === "compaction" && !transformed.toolArgs) {
      const compactionArgs: Record<string, unknown> = {};
      if (typeof event.messageCount === "number") compactionArgs.messageCount = event.messageCount;
      if (typeof event.tokenCount === "number") compactionArgs.tokenCount = event.tokenCount;
      if (typeof event.contextLimit === "number") compactionArgs.contextLimit = event.contextLimit;
      if (typeof event.contextPercent === "number") compactionArgs.contextPercent = event.contextPercent;
      if (event.trigger != null) compactionArgs.trigger = event.trigger;
      if (Object.keys(compactionArgs).length > 0) transformed.toolArgs = compactionArgs;
    }

    if (event.type === "scan" && !transformed.toolArgs) {
      const scanArgs: Record<string, unknown> = {};
      if (Array.isArray(event.skills)) scanArgs.skills = (event.skills as any[]).map((s: any) => s.name ?? s);
      if (Array.isArray(event.plugins)) scanArgs.plugins = (event.plugins as any[]).map((p: any) => ({ name: p.name ?? p, version: p.version }));
      if (typeof event.totalSkills === "number") scanArgs.totalSkills = event.totalSkills;
      if (typeof event.totalPlugins === "number") scanArgs.totalPlugins = event.totalPlugins;
      if (event.changes != null) scanArgs.changes = event.changes;
      if (Object.keys(scanArgs).length > 0) transformed.toolArgs = scanArgs;
    }

    // Include resultPreview in toolArgs for tool_result events
    if (event.type === "tool_result" && event.resultPreview) {
      transformed.toolArgs = {
        ...((transformed.toolArgs as Record<string, unknown>) || {}),
        resultPreview: event.resultPreview,
      };
    }

    if (typeof event.redactedCount === "number") transformed.redactedCount = event.redactedCount;
    if (typeof event.correlationId === "string") transformed.correlationId = event.correlationId;

    return transformed;
  });
}

async function sendBatch(events: PodwatchEvent[]): Promise<boolean> {
  if (!config) return false;

  const payload = {
    events: transformEvents(events),
    pluginVersion: PLUGIN_VERSION,
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

      // Parse response body for budget state + urgent update signals
      try {
        const body = (await response.json()) as {
          hardStop?: boolean;
          budgetExceeded?: boolean;
          update?: { version?: string; urgent?: boolean };
        };

        // Budget state updates
        if (cachedBudget && (body.hardStop != null || body.budgetExceeded != null)) {
          if (typeof body.hardStop === "boolean") {
            cachedBudget.hardStopActive = body.hardStop;
          }
          if (typeof body.budgetExceeded === "boolean" && body.budgetExceeded) {
            cachedBudget.currentSpend = cachedBudget.limit;
            cachedBudget.dailySpend = cachedBudget.dailyLimit;
          }
        }

        // Urgent update signal — bypass 24h cooldown
        if (body.update?.urgent && typeof body.update.version === "string") {
          const logger = {
            info: (msg: string) => console.log(msg),
            warn: (msg: string) => console.warn(msg),
            error: (msg: string) => console.error(msg),
          };
          void handleUrgentUpdate(body.update.version, logger);
        }
      } catch {
        // Response may not be JSON — that's fine
      }

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
      retryCount = 0;
    } else {
      retryCount++;
      // Drop batch only after exhausting all retries
      if (retryCount >= MAX_RETRIES) {
        writeAuditLog("max_retries_exceeded", batch.length, batch);
        buffer.splice(0, batchSize);
        retryBackoffMs = 1_000;
        retryCount = 0;
      } else {
        // Keep events in buffer (don't splice) — retry on next flush
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
 * Sync budget from dashboard API. Called on activate + every 300s.
 * Stale by up to 5 min — acceptable with 95% tolerance buffer.
 * Gracefully handles 404 (endpoint not deployed yet) without spamming logs.
 */
let budgetSyncFailures = 0;
const BUDGET_SYNC_MAX_SILENT_FAILURES = 3; // Only warn after N consecutive failures

async function syncBudget(): Promise<void> {
  if (!config) return;

  try {
    const response = await fetch(`${config.endpoint}/budget-status`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        exceeded?: boolean;
        dailySpend?: number;
        dailyLimit?: number;
        monthlySpend?: number;
        monthlyLimit?: number;
        hardStopEnabled?: boolean;
        hardStopActive?: boolean;
      };
      cachedBudget = {
        limit: typeof data.dailyLimit === "number" ? data.dailyLimit : 0,
        currentSpend: typeof data.dailySpend === "number" ? data.dailySpend : 0,
        dailySpend: typeof data.dailySpend === "number" ? data.dailySpend : 0,
        dailyLimit: typeof data.dailyLimit === "number" ? data.dailyLimit : 0,
        monthlySpend: typeof data.monthlySpend === "number" ? data.monthlySpend : 0,
        monthlyLimit: typeof data.monthlyLimit === "number" ? data.monthlyLimit : 0,
        hardStopEnabled: data.hardStopEnabled === true,
        hardStopActive: data.hardStopActive === true,
        lastSyncTs: Date.now(),
      };
      budgetSyncFailures = 0;
      return;
    }

    // 404 — endpoint not deployed yet, silently ignore
    if (response.status === 404) {
      budgetSyncFailures++;
      if (budgetSyncFailures === BUDGET_SYNC_MAX_SILENT_FAILURES) {
        console.warn("[podwatch] Budget status endpoint not available (404). Budget sync disabled until endpoint is deployed.");
      }
      return;
    }

    budgetSyncFailures++;
    if (budgetSyncFailures <= BUDGET_SYNC_MAX_SILENT_FAILURES) {
      console.warn(`[podwatch] Budget sync failed: HTTP ${response.status}`);
    }
  } catch (err) {
    budgetSyncFailures++;
    if (budgetSyncFailures <= BUDGET_SYNC_MAX_SILENT_FAILURES) {
      console.warn("[podwatch] Budget sync network error:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const transmitter = {
  start(cfg: TransmitterConfig): void {
    config = cfg;
    buffer = [];
    retryBackoffMs = 1_000;
    retryCount = 0;
    flushInProgress = false;
    trialExpired = false;
    activateTs = Date.now();
    knownTools.clear();
    recentCredentialAccesses.length = 0;
    cachedBudget = null;
    budgetSyncFailures = 0;

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

    // Overflow protection — drop non-critical events down to BUFFER_TARGET_SIZE
    if (buffer.length > MAX_BUFFER_SIZE) {
      const criticalTypes = new Set(["setup_warning", "security", "budget_blocked"]);
      const dropCount = buffer.length - BUFFER_TARGET_SIZE;

      // Collect indices of non-critical events (oldest first)
      const nonCriticalIndices: number[] = [];
      for (let i = 0; i < buffer.length && nonCriticalIndices.length < dropCount; i++) {
        if (!criticalTypes.has(buffer[i]!.type)) {
          nonCriticalIndices.push(i);
        }
      }

      // If not enough non-critical events, also drop critical (oldest first)
      if (nonCriticalIndices.length < dropCount) {
        for (let i = 0; i < buffer.length && nonCriticalIndices.length < dropCount; i++) {
          if (criticalTypes.has(buffer[i]!.type)) {
            nonCriticalIndices.push(i);
          }
        }
      }

      // Remove in reverse order to preserve indices
      const dropped: PodwatchEvent[] = [];
      const indicesToDrop = nonCriticalIndices.sort((a, b) => b - a);
      for (const idx of indicesToDrop) {
        dropped.push(buffer[idx]!);
        buffer.splice(idx, 1);
      }

      if (dropped.length > 0) {
        writeAuditLog("buffer_overflow", dropped.length, dropped);
        console.warn(`[podwatch] Buffer overflow: dropped ${dropped.length} events (target: ${BUFFER_TARGET_SIZE})`);
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

  /** Record a tool as seen. Clears the set when it exceeds KNOWN_TOOLS_MAX_SIZE. */
  recordToolSeen(toolName: string): void {
    knownTools.add(toolName);
    if (knownTools.size > KNOWN_TOOLS_MAX_SIZE) {
      console.warn(
        `[podwatch] knownTools set exceeded ${KNOWN_TOOLS_MAX_SIZE} entries — resetting first-time-tool baseline`
      );
      knownTools.clear();
      knownTools.add(toolName);
    }
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

  /** Update cached budget from event ingestion response (immediate, no network). */
  updateBudgetFromResponse(response: { hardStop?: boolean; budgetExceeded?: boolean }): void {
    if (!cachedBudget) return;
    if (typeof response.hardStop === "boolean") {
      cachedBudget.hardStopActive = response.hardStop;
    }
    if (typeof response.budgetExceeded === "boolean" && response.budgetExceeded) {
      cachedBudget.currentSpend = cachedBudget.limit;
      cachedBudget.dailySpend = cachedBudget.dailyLimit;
    }
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
