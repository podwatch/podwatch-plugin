/**
 * Config health doctor — reads OpenClaw config + state files from disk,
 * runs 8 health checks, computes an overall score (0-100), and sends
 * changes to the Podwatch dashboard.
 *
 * Health checks:
 *   1. Channel health — probe failures or warnings
 *   2. Plugin health — loaded vs errored, disabled count
 *   3. Skills health — eligible vs missing requirements
 *   4. Session locks — detect stale lock files
 *   5. Security config — sandbox mode + Docker, tool policy gaps
 *   6. Memory readiness — embedding model configured
 *   7. Heartbeat config — enabled, reasonable interval
 *   8. Config warnings — unknown keys, deprecated settings
 *
 * Uses the same change-detection pattern as auth-monitor.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  check: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface ConfigHealthResult {
  score: number;
  checks: HealthCheck[];
  checkedAt: string;
}

interface OpenClawConfig {
  channels?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  skills?: Record<string, unknown> | unknown[];
  agents?: {
    defaults?: {
      workspace?: string;
      sandbox?: string | { mode?: string; [key: string]: unknown };
      toolPolicy?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  memory?: {
    embedding?: { model?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  heartbeat?: {
    enabled?: boolean;
    intervalMs?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Known top-level config keys (OpenClaw v1.x). Used for unknown-key detection. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "channels",
  "plugins",
  "skills",
  "agents",
  "memory",
  "heartbeat",
  "crons",
  "nodes",
  "security",
  "system",
  "server",
  "gateway",
  "logging",
  "tools",
  "mcp",
  "models",
  "auth",
  "env",
  "hooks",
  "experimental",
]);

/** Deprecated config keys and their replacements. */
const DEPRECATED_KEYS: Record<string, string> = {
  llm: "models",
  bot: "agents",
  sandbox: "agents.defaults.sandbox",
};

/** Stale lock file threshold — 2 hours */
const STALE_LOCK_THRESHOLD_MS = 2 * 60 * 60 * 1_000;

/** Heartbeat interval bounds (reasonable range) */
const HEARTBEAT_MIN_MS = 30_000;       // 30 seconds
const HEARTBEAT_MAX_MS = 3_600_000;    // 1 hour

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastSnapshot: string | null = null;
let lastSendTime: number = 0;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let configuredEndpoint: string | null = null;
let configuredApiKey: string | null = null;

/** Max time between sends even if nothing changed (1 hour). */
const FORCE_SEND_INTERVAL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Core: State directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw state directory.
 */
export function resolveStateDir(): string {
  const override =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".openclaw");
}

/**
 * Read and parse the OpenClaw config file.
 */
export function readOpenClawConfig(stateDir?: string): OpenClawConfig | null {
  const base = stateDir ?? resolveStateDir();
  const configPath = path.join(base, "openclaw.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as OpenClawConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Individual health checks
// ---------------------------------------------------------------------------

/**
 * 1. Channel health — checks channel config for issues.
 */
export function checkChannelHealth(config: OpenClawConfig): HealthCheck {
  const channels = config.channels;
  if (!channels || typeof channels !== "object") {
    return {
      check: "channels",
      status: "warn",
      message: "No channels configured",
    };
  }

  const channelKeys = Object.keys(channels);
  if (channelKeys.length === 0) {
    return {
      check: "channels",
      status: "warn",
      message: "No channels configured",
    };
  }

  let disabledCount = 0;
  const issues: string[] = [];

  for (const key of channelKeys) {
    const ch = channels[key];
    if (ch && typeof ch === "object") {
      const channelObj = ch as Record<string, unknown>;
      if (channelObj.enabled === false) {
        disabledCount++;
      }
      if (channelObj.error || channelObj.lastError) {
        issues.push(`${key}: has error`);
      }
    }
  }

  if (issues.length > 0) {
    return {
      check: "channels",
      status: "fail",
      message: `${issues.length} channel(s) with errors`,
      detail: issues.join("; "),
    };
  }

  if (disabledCount === channelKeys.length) {
    return {
      check: "channels",
      status: "warn",
      message: "All channels are disabled",
    };
  }

  if (disabledCount > 0) {
    return {
      check: "channels",
      status: "pass",
      message: `${channelKeys.length} channels (${disabledCount} disabled)`,
    };
  }

  return {
    check: "channels",
    status: "pass",
    message: `${channelKeys.length} channel(s) configured`,
  };
}

/**
 * 2. Plugin health — loaded vs errored/disabled plugins.
 */
export function checkPluginHealth(config: OpenClawConfig): HealthCheck {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== "object") {
    return {
      check: "plugins",
      status: "pass",
      message: "No plugins configured",
    };
  }

  const pluginKeys = Object.keys(plugins);
  if (pluginKeys.length === 0) {
    return {
      check: "plugins",
      status: "pass",
      message: "No plugins configured",
    };
  }

  let disabledCount = 0;
  let errorCount = 0;
  const errors: string[] = [];

  for (const key of pluginKeys) {
    const plugin = plugins[key];
    if (plugin && typeof plugin === "object") {
      const p = plugin as Record<string, unknown>;
      if (p.enabled === false || p.disabled === true) {
        disabledCount++;
      }
      if (p.error || p.loadError) {
        errorCount++;
        errors.push(key);
      }
    }
  }

  if (errorCount > 0) {
    return {
      check: "plugins",
      status: "fail",
      message: `${errorCount} plugin(s) with errors`,
      detail: `Errored: ${errors.join(", ")}`,
    };
  }

  if (disabledCount > 0) {
    return {
      check: "plugins",
      status: "warn",
      message: `${pluginKeys.length} plugins (${disabledCount} disabled)`,
    };
  }

  return {
    check: "plugins",
    status: "pass",
    message: `${pluginKeys.length} plugin(s) loaded`,
  };
}

/**
 * 3. Skills health — count skills, check for missing requirements.
 */
export function checkSkillsHealth(config: OpenClawConfig): HealthCheck {
  const skills = config.skills;
  if (!skills) {
    return {
      check: "skills",
      status: "pass",
      message: "No skills configured",
    };
  }

  // Skills can be an array or object
  const skillEntries = Array.isArray(skills)
    ? skills
    : Object.values(skills);

  if (skillEntries.length === 0) {
    return {
      check: "skills",
      status: "pass",
      message: "No skills configured",
    };
  }

  let missingReqs = 0;
  for (const skill of skillEntries) {
    if (skill && typeof skill === "object") {
      const s = skill as Record<string, unknown>;
      if (s.eligible === false || s.missingRequirements) {
        missingReqs++;
      }
    }
  }

  if (missingReqs > 0) {
    return {
      check: "skills",
      status: "warn",
      message: `${skillEntries.length} skills (${missingReqs} with missing requirements)`,
    };
  }

  return {
    check: "skills",
    status: "pass",
    message: `${skillEntries.length} skill(s) configured`,
  };
}

/**
 * 4. Session locks — detect stale lock files in state dir.
 */
export function checkSessionLocks(stateDir?: string, now?: number): HealthCheck {
  const base = stateDir ?? resolveStateDir();
  const currentTime = now ?? Date.now();

  // Check multiple possible lock locations
  const lockDirs = [
    path.join(base, "locks"),
    path.join(base, "sessions"),
    path.join(base, "agents"),
  ];

  let totalLocks = 0;
  let staleLocks = 0;
  const staleFiles: string[] = [];

  for (const dir of lockDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".pid")) {
          totalLocks++;
          try {
            const filePath = path.join(dir, entry.name);
            const stat = fs.statSync(filePath);
            if (currentTime - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              staleLocks++;
              staleFiles.push(entry.name);
            }
          } catch {
            // Can't stat — count as stale
            staleLocks++;
            staleFiles.push(entry.name);
          }
        }
      }
    } catch {
      // Directory doesn't exist — that's fine
    }
  }

  if (staleLocks > 0) {
    return {
      check: "session_locks",
      status: "warn",
      message: `${staleLocks} stale lock file(s) detected`,
      detail: staleFiles.join(", "),
    };
  }

  if (totalLocks > 0) {
    return {
      check: "session_locks",
      status: "pass",
      message: `${totalLocks} active lock(s), none stale`,
    };
  }

  return {
    check: "session_locks",
    status: "pass",
    message: "No lock files found",
  };
}

/**
 * 5. Security config — sandbox mode + Docker availability, tool policy.
 */
export function checkSecurityConfig(config: OpenClawConfig): HealthCheck {
  const sandbox = config.agents?.defaults?.sandbox;
  const toolPolicy = config.agents?.defaults?.toolPolicy;
  const issues: string[] = [];

  // Check sandbox config
  let sandboxMode: string | undefined;
  if (typeof sandbox === "string") {
    sandboxMode = sandbox;
  } else if (sandbox && typeof sandbox === "object") {
    sandboxMode = (sandbox as Record<string, unknown>).mode as string | undefined;
  }

  if (sandboxMode && sandboxMode !== "off" && sandboxMode !== "none") {
    // Sandbox is on — check if Docker is likely available
    try {
      fs.accessSync("/var/run/docker.sock", fs.constants.R_OK);
    } catch {
      issues.push("Sandbox enabled but Docker socket not accessible");
    }
  }

  // Check tool policy
  if (!toolPolicy || typeof toolPolicy !== "object" || Object.keys(toolPolicy).length === 0) {
    issues.push("No tool policy configured");
  }

  if (issues.length > 0 && issues.some((i) => i.includes("Docker"))) {
    return {
      check: "security",
      status: "fail",
      message: issues[0]!,
      detail: issues.length > 1 ? issues.join("; ") : undefined,
    };
  }

  if (issues.length > 0) {
    return {
      check: "security",
      status: "warn",
      message: issues[0]!,
      detail: issues.length > 1 ? issues.join("; ") : undefined,
    };
  }

  return {
    check: "security",
    status: "pass",
    message: "Security configuration looks good",
  };
}

/**
 * 6. Memory readiness — embedding model configured.
 */
export function checkMemoryReadiness(config: OpenClawConfig): HealthCheck {
  const memory = config.memory;
  if (!memory || typeof memory !== "object") {
    return {
      check: "memory",
      status: "warn",
      message: "Memory not configured",
    };
  }

  const embeddingModel = memory.embedding?.model;
  if (!embeddingModel) {
    return {
      check: "memory",
      status: "warn",
      message: "No embedding model configured",
      detail: "Memory features may not work without an embedding model",
    };
  }

  return {
    check: "memory",
    status: "pass",
    message: `Embedding model: ${embeddingModel}`,
  };
}

/**
 * 7. Heartbeat config — enabled + reasonable interval.
 */
export function checkHeartbeatConfig(config: OpenClawConfig): HealthCheck {
  const heartbeat = config.heartbeat;
  if (!heartbeat || typeof heartbeat !== "object") {
    return {
      check: "heartbeat",
      status: "warn",
      message: "Heartbeat not configured",
    };
  }

  if (heartbeat.enabled === false) {
    return {
      check: "heartbeat",
      status: "warn",
      message: "Heartbeat is disabled",
    };
  }

  const interval = heartbeat.intervalMs;
  if (typeof interval === "number") {
    if (interval < HEARTBEAT_MIN_MS) {
      return {
        check: "heartbeat",
        status: "warn",
        message: `Heartbeat interval too low (${interval}ms)`,
        detail: `Minimum recommended: ${HEARTBEAT_MIN_MS}ms`,
      };
    }
    if (interval > HEARTBEAT_MAX_MS) {
      return {
        check: "heartbeat",
        status: "warn",
        message: `Heartbeat interval very high (${interval}ms)`,
        detail: `Maximum recommended: ${HEARTBEAT_MAX_MS}ms`,
      };
    }
  }

  return {
    check: "heartbeat",
    status: "pass",
    message: "Heartbeat enabled" + (typeof interval === "number" ? ` (${interval}ms)` : ""),
  };
}

/**
 * 8. Config warnings — unknown or deprecated top-level keys.
 */
export function checkConfigWarnings(config: OpenClawConfig): HealthCheck {
  const keys = Object.keys(config);
  const unknownKeys: string[] = [];
  const deprecatedKeys: string[] = [];

  for (const key of keys) {
    if (DEPRECATED_KEYS[key]) {
      deprecatedKeys.push(`"${key}" → use "${DEPRECATED_KEYS[key]}"`);
    } else if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      unknownKeys.push(key);
    }
  }

  if (deprecatedKeys.length > 0) {
    return {
      check: "config_warnings",
      status: "warn",
      message: `${deprecatedKeys.length} deprecated key(s)`,
      detail: deprecatedKeys.join("; "),
    };
  }

  if (unknownKeys.length > 0) {
    return {
      check: "config_warnings",
      status: "warn",
      message: `${unknownKeys.length} unknown config key(s)`,
      detail: unknownKeys.join(", "),
    };
  }

  return {
    check: "config_warnings",
    status: "pass",
    message: "No config warnings",
  };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute an overall health score from checks.
 * Each check starts at 100/N points. Fails subtract 20, warns subtract 5.
 */
export function computeHealthScore(checks: HealthCheck[]): number {
  if (checks.length === 0) return 100;

  let score = 100;
  for (const check of checks) {
    if (check.status === "fail") {
      score -= 20;
    } else if (check.status === "warn") {
      score -= 5;
    }
  }

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Main check orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all health checks and return the result.
 */
export function runAllChecks(stateDir?: string, now?: number): ConfigHealthResult & { rawConfig?: OpenClawConfig | null } {
  const config = readOpenClawConfig(stateDir);

  // If we can't read the config, that's a critical failure
  if (!config) {
    return {
      score: 0,
      checks: [{
        check: "config_read",
        status: "fail",
        message: "Cannot read OpenClaw config",
        detail: "Config file not found or invalid JSON",
      }],
      checkedAt: new Date().toISOString(),
      rawConfig: null,
    };
  }

  const checks: HealthCheck[] = [
    checkChannelHealth(config),
    checkPluginHealth(config),
    checkSkillsHealth(config),
    checkSessionLocks(stateDir, now),
    checkSecurityConfig(config),
    checkMemoryReadiness(config),
    checkHeartbeatConfig(config),
    checkConfigWarnings(config),
  ];

  return {
    score: computeHealthScore(checks),
    checks,
    checkedAt: new Date().toISOString(),
    rawConfig: config,
  };
}

/**
 * Check config health and send changes to the dashboard.
 * Returns the result (for testing).
 */
export function checkConfigHealth(stateDir?: string, now?: number): ConfigHealthResult {
  try {
    const { rawConfig, ...result } = runAllChecks(stateDir, now);
    const currentTime = now ?? Date.now();

    // Change detection — only send if score/checks changed or it's been > 1 hour
    const snapshot = JSON.stringify({ score: result.score, checks: result.checks });
    const timeSinceLastSend = currentTime - lastSendTime;
    const shouldSend = snapshot !== lastSnapshot || timeSinceLastSend >= FORCE_SEND_INTERVAL_MS;

    if (shouldSend) {
      lastSnapshot = snapshot;
      lastSendTime = currentTime;
      void sendConfigHealthToApi(result, rawConfig);
    }

    return result;
  } catch (err) {
    try {
      console.error("[podwatch/config-doctor] Error checking config health:", err);
    } catch {
      // Swallow
    }
    return {
      score: 0,
      checks: [{
        check: "config_read",
        status: "fail",
        message: "Error running health checks",
      }],
      checkedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Config sanitization
// ---------------------------------------------------------------------------

/** Keys whose values must be redacted (case-insensitive substring match). */
const SENSITIVE_KEY_PATTERNS = [
  "token", "secret", "password", "apikey", "api_key", "credential",
  "private", "auth_token", "bottoken", "bot_token", "webhook",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Deep-clone a config object, replacing sensitive values with "[REDACTED]".
 * Preserves structure so the server can analyze keys, nesting, and non-secret values.
 */
export function sanitizeConfig(obj: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "boolean" || typeof obj === "number") return obj;
  if (typeof obj === "string") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeConfig(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string" && (value.startsWith("pw_") || value.startsWith("sk-") || value.startsWith("gsk_") || value.match(/^[a-f0-9]{32,}$/i))) {
        // Looks like a raw secret value even if key isn't flagged
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeConfig(value, depth + 1);
      }
    }
    return result;
  }

  return String(obj);
}

// ---------------------------------------------------------------------------
// API communication
// ---------------------------------------------------------------------------

/**
 * Send config health data + sanitized config snapshot to the Podwatch API.
 */
async function sendConfigHealthToApi(result: ConfigHealthResult, rawConfig?: OpenClawConfig | null): Promise<void> {
  if (!configuredEndpoint || !configuredApiKey) return;

  try {
    const payload: Record<string, unknown> = {
      score: result.score,
      checks: result.checks,
      checkedAt: result.checkedAt,
    };

    // Include sanitized config so server can derive its own checks
    if (rawConfig) {
      payload.configSnapshot = sanitizeConfig(rawConfig);
    }

    const response = await fetch(`${configuredEndpoint}/config-health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${configuredApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`[podwatch/config-doctor] API ${response.status}`);
    }
  } catch (err) {
    try {
      console.error("[podwatch/config-doctor] Failed to send config health:", err);
    } catch {
      // Swallow
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the config health monitor.
 */
export function startConfigDoctor(
  intervalMs: number = 900_000, // 15 minutes
  stateDir?: string,
  endpoint?: string,
  apiKey?: string,
): void {
  stopConfigDoctor();
  resetConfigDoctorState();

  configuredEndpoint = endpoint ?? null;
  configuredApiKey = apiKey ?? null;

  // Initial check
  checkConfigHealth(stateDir);

  // Periodic checks
  monitorTimer = setInterval(() => checkConfigHealth(stateDir), intervalMs);
  if (monitorTimer && typeof monitorTimer === "object" && "unref" in monitorTimer) {
    monitorTimer.unref();
  }
}

/**
 * Stop the config health monitor.
 */
export function stopConfigDoctor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Reset cached state (for testing).
 */
export function resetConfigDoctorState(): void {
  lastSnapshot = null;
  lastSendTime = 0;
  configuredEndpoint = null;
  configuredApiKey = null;
}
