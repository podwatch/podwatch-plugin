/**
 * Auth profile health monitor — reads OpenClaw auth profiles from disk,
 * computes health status, and sends changes to the Podwatch dashboard.
 *
 * Status classification:
 *   healthy       — no issues
 *   expiring_soon — token/oauth expires within 24h
 *   expired       — token/oauth is past expiry
 *   cooldown      — cooldownUntil is in the future
 *   disabled      — disabledUntil is in the future
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthProfileStatus =
  | "healthy"
  | "expiring_soon"
  | "expired"
  | "cooldown"
  | "disabled";

export interface AuthProfileHealth {
  id: string;
  provider: string;
  authType: string;
  status: AuthProfileStatus;
  expiresAt?: string;        // ISO timestamp
  cooldownUntil?: string;    // ISO timestamp
  disabledUntil?: string;    // ISO timestamp
  disabledReason?: string;
  errorCount?: number;
}

interface AuthProfileFile {
  version?: number;
  profiles?: Record<string, ProfileEntry>;
  usageStats?: Record<string, UsageStatsEntry>;
  [key: string]: unknown;
}

interface ProfileEntry {
  type?: string;
  provider?: string;
  expires?: number | string;
  expiresAt?: number | string;
  disabledUntil?: number | string;
  disabledReason?: string;
  [key: string]: unknown;
}

interface UsageStatsEntry {
  errorCount?: number;
  cooldownUntil?: number | string;
  disabledUntil?: number | string;
  disabledReason?: string;
  failureCounts?: Record<string, number>;
  lastFailureAt?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastSnapshot: string | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let configuredEndpoint: string | null = null;
let configuredApiKey: string | null = null;

// ---------------------------------------------------------------------------
// Core logic
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
 * Find auth-profiles.json. Checks multiple known locations.
 */
export function findAuthProfilesPath(stateDir?: string): string | null {
  const base = stateDir ?? resolveStateDir();
  const candidates = [
    path.join(base, "credentials", "auth-profiles.json"),
    path.join(base, "agents", "main", "agent", "auth-profiles.json"),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // Try next
    }
  }
  return null;
}

/**
 * Read and parse the auth profiles file.
 */
export function readAuthProfiles(filePath: string): AuthProfileFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AuthProfileFile;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse a timestamp value that could be a number (epoch ms) or ISO string.
 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Compute health status for a single auth profile.
 */
export function computeProfileHealth(
  id: string,
  profile: ProfileEntry,
  usageStats?: UsageStatsEntry,
  now?: number,
): AuthProfileHealth {
  const currentTime = now ?? Date.now();
  const provider = profile.provider ?? id.split(":")[0] ?? "unknown";
  const authType = profile.type ?? "unknown";

  const result: AuthProfileHealth = {
    id,
    provider,
    authType,
    status: "healthy",
  };

  // Check disabled status (from profile or usageStats)
  const disabledUntilRaw =
    profile.disabledUntil ?? usageStats?.disabledUntil;
  const disabledUntil = parseTimestamp(disabledUntilRaw);
  if (disabledUntil !== null && disabledUntil > currentTime) {
    result.status = "disabled";
    result.disabledUntil = new Date(disabledUntil).toISOString();
    result.disabledReason =
      profile.disabledReason ?? usageStats?.disabledReason ?? undefined;
  }

  // Check cooldown (from usageStats)
  const cooldownUntilRaw = usageStats?.cooldownUntil;
  const cooldownUntil = parseTimestamp(cooldownUntilRaw);
  if (
    cooldownUntil !== null &&
    cooldownUntil > currentTime &&
    result.status === "healthy"
  ) {
    result.status = "cooldown";
    result.cooldownUntil = new Date(cooldownUntil).toISOString();
  }

  // Check token/oauth expiry
  const expiresRaw = profile.expires ?? profile.expiresAt;
  const expiresAt = parseTimestamp(expiresRaw);
  if (expiresAt !== null) {
    result.expiresAt = new Date(expiresAt).toISOString();

    if (expiresAt <= currentTime && result.status === "healthy") {
      result.status = "expired";
    } else if (
      expiresAt <= currentTime + EXPIRY_WARNING_MS &&
      result.status === "healthy"
    ) {
      result.status = "expiring_soon";
    }
  }

  // Attach error count if present
  const errorCount = usageStats?.errorCount;
  if (typeof errorCount === "number" && errorCount > 0) {
    result.errorCount = errorCount;
  }

  return result;
}

/**
 * Compute health for all profiles in the file.
 */
export function computeAllProfileHealth(
  data: AuthProfileFile,
  now?: number,
): AuthProfileHealth[] {
  const profiles = data.profiles;
  if (!profiles || typeof profiles !== "object") return [];

  const usageStats = data.usageStats ?? {};
  const results: AuthProfileHealth[] = [];

  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const stats = usageStats[id];
    results.push(computeProfileHealth(id, profile, stats, now));
  }

  return results;
}

/**
 * Check auth profiles and send changes to the dashboard.
 * Returns the computed profiles (for testing).
 */
export function checkAuthHealth(stateDir?: string): AuthProfileHealth[] {
  try {
    const filePath = findAuthProfilesPath(stateDir);
    if (!filePath) return [];

    const data = readAuthProfiles(filePath);
    if (!data) return [];

    const profiles = computeAllProfileHealth(data);
    if (profiles.length === 0) return [];

    // Compute snapshot for change detection
    const snapshot = JSON.stringify(profiles);
    if (snapshot === lastSnapshot) {
      return profiles; // No changes
    }

    lastSnapshot = snapshot;

    // Send auth_health directly to the dedicated endpoint
    void sendAuthHealthToApi(profiles);

    return profiles;
  } catch (err) {
    try {
      console.error("[podwatch/auth-monitor] Error checking auth health:", err);
    } catch {
      // Swallow
    }
    return [];
  }
}

/**
 * Send auth health data directly to the Podwatch API.
 */
async function sendAuthHealthToApi(profiles: AuthProfileHealth[]): Promise<void> {
  if (!configuredEndpoint || !configuredApiKey) return;

  try {
    const response = await fetch(`${configuredEndpoint}/auth-health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${configuredApiKey}`,
      },
      body: JSON.stringify({
        type: "auth_health",
        profiles: profiles.map((p) => ({
          id: p.id,
          provider: p.provider,
          authType: p.authType,
          status: p.status,
          expiresAt: p.expiresAt,
          cooldownUntil: p.cooldownUntil,
          disabledUntil: p.disabledUntil,
          disabledReason: p.disabledReason,
          errorCount: p.errorCount,
        })),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`[podwatch/auth-monitor] API ${response.status}`);
    }
  } catch (err) {
    console.error("[podwatch/auth-monitor] Failed to send auth health:", err);
  }
}

/**
 * Reset cached snapshot (for testing or re-init).
 */
export function resetAuthSnapshot(): void {
  lastSnapshot = null;
}

/**
 * Start periodic auth health monitoring.
 */
export function startAuthMonitor(
  intervalMs: number = 900_000, // 15 minutes
  stateDir?: string,
  endpoint?: string,
  apiKey?: string,
): void {
  stopAuthMonitor();
  resetAuthSnapshot();

  // Store API config for sending health data
  configuredEndpoint = endpoint ?? null;
  configuredApiKey = apiKey ?? null;

  // Initial check
  checkAuthHealth(stateDir);

  // Periodic checks
  monitorTimer = setInterval(() => checkAuthHealth(stateDir), intervalMs);
  if (monitorTimer && typeof monitorTimer === "object" && "unref" in monitorTimer) {
    monitorTimer.unref();
  }
}

/**
 * Stop the periodic auth health monitor.
 */
export function stopAuthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
