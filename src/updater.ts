/**
 * Auto-updater for the Podwatch plugin.
 *
 * On plugin startup (called from register()), schedules a non-blocking update
 * check after a 30-second delay. If a new version is available on npm (or the
 * Podwatch dashboard fallback), it runs `openclaw plugins update podwatch` and
 * triggers a gateway restart via `openclaw gateway restart`.
 *
 * Safety:
 * - 30s startup delay (don't slow boot)
 * - 24-hour cooldown between checks (cached in a local file)
 * - 5s timeout on all HTTP requests
 * - 60s timeout on update command
 * - All errors caught — never bricks the running plugin
 * - Logs all activity for debugging
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NPM_REGISTRY_URL = "https://registry.npmjs.org/podwatch/latest";
const CHECK_TIMEOUT_MS = 5_000;
const UPDATE_TIMEOUT_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const CACHE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".openclaw",
  "extensions",
  "podwatch"
);

export const AUTO_UPDATE_CACHE_FILE = path.join(CACHE_DIR, ".last-update-check");

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver-like version strings.
 * Returns positive if remote > local, negative if local > remote, 0 if equal.
 */
export function compareVersions(local: string, remote: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const l = parse(local);
  const r = parse(remote);
  const len = Math.max(l.length, r.length);

  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0;
    const rv = r[i] ?? 0;
    if (rv !== lv) return rv - lv;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Cache (24-hour cooldown)
// ---------------------------------------------------------------------------

/**
 * Check if we should perform a version check (respects 24h cooldown).
 */
export function shouldCheckForUpdate(): boolean {
  try {
    if (!fs.existsSync(AUTO_UPDATE_CACHE_FILE)) return true;

    const raw = fs.readFileSync(AUTO_UPDATE_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as { lastCheckTs?: number };
    if (typeof data.lastCheckTs !== "number") return true;

    return Date.now() - data.lastCheckTs > COOLDOWN_MS;
  } catch {
    return true; // On any error, allow the check
  }
}

/**
 * Persist the current timestamp as last-check time.
 */
export function writeCacheTimestamp(): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      AUTO_UPDATE_CACHE_FILE,
      JSON.stringify({ lastCheckTs: Date.now() })
    );
  } catch (err) {
    console.warn("[podwatch/updater] Failed to write cache:", err);
  }
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  available: boolean;
  remoteVersion: string;
  source: "npm" | "dashboard";
}

/**
 * Check for a newer version. Tries npm registry first, then dashboard API.
 * Returns null if both checks fail.
 */
export async function checkForUpdate(
  currentVersion: string,
  endpoint: string
): Promise<UpdateCheckResult | null> {
  // 1. Try npm registry
  try {
    const resp = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { version?: string };
      if (typeof data.version === "string" && data.version) {
        const cmp = compareVersions(currentVersion, data.version);
        return {
          available: cmp > 0,
          remoteVersion: data.version,
          source: "npm",
        };
      }
    }
  } catch {
    // Fall through to dashboard
  }

  // 2. Fallback: dashboard API
  try {
    const dashboardUrl = `${endpoint}/plugin-version`;
    const resp = await fetch(dashboardUrl, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { version?: string };
      if (typeof data.version === "string" && data.version) {
        const cmp = compareVersions(currentVersion, data.version);
        return {
          available: cmp > 0,
          remoteVersion: data.version,
          source: "dashboard",
        };
      }
    }
  } catch {
    // Both failed
  }

  return null;
}

// ---------------------------------------------------------------------------
// Update execution
// ---------------------------------------------------------------------------

export interface UpdateResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Run `openclaw plugins update podwatch` via child_process.exec.
 */
export function executeUpdate(): Promise<UpdateResult> {
  return new Promise((resolve) => {
    exec(
      "openclaw plugins update podwatch",
      { timeout: UPDATE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            stdout: stdout?.toString(),
            stderr: stderr?.toString(),
            error: err.message,
          });
        } else {
          resolve({
            success: true,
            stdout: stdout?.toString(),
            stderr: stderr?.toString(),
          });
        }
      }
    );
  });
}

/**
 * Trigger a gateway restart after update.
 * Uses `openclaw gateway restart` which sends SIGUSR1 for a hot-reload.
 */
function triggerGatewayRestart(): void {
  exec("openclaw gateway restart", { timeout: 30_000 }, (err) => {
    if (err) {
      console.error("[podwatch/updater] Gateway restart failed:", err.message);
      console.info(
        "[podwatch/updater] Plugin updated but restart failed. Manual restart required."
      );
    } else {
      console.info("[podwatch/updater] Gateway restart triggered.");
    }
  });
}

// ---------------------------------------------------------------------------
// Main entry point (called from register())
// ---------------------------------------------------------------------------

/**
 * Schedule a non-blocking update check 30s after startup.
 * Safe to call synchronously — it sets a timer and returns immediately.
 *
 * @param currentVersion The plugin's current version from package.json
 * @param endpoint The Podwatch API endpoint (for dashboard fallback)
 * @param logger The plugin logger (api.logger)
 */
export function scheduleUpdateCheck(
  currentVersion: string,
  endpoint: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): void {
  const timer = setTimeout(() => {
    void runUpdateCheck(currentVersion, endpoint, logger);
  }, STARTUP_DELAY_MS);

  // Don't hold the process open for this timer
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

/**
 * Internal: perform the actual update check + install + restart.
 */
async function runUpdateCheck(
  currentVersion: string,
  endpoint: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): Promise<void> {
  try {
    // Respect 24h cooldown
    if (!shouldCheckForUpdate()) {
      console.log("[podwatch/updater] Skipping check — within 24h cooldown.");
      return;
    }

    logger.info("[podwatch/updater] Checking for updates...");

    const result = await checkForUpdate(currentVersion, endpoint);

    // Always write cache timestamp after a check attempt (even if no update)
    writeCacheTimestamp();

    if (!result) {
      logger.warn("[podwatch/updater] Could not determine latest version (both sources failed).");
      return;
    }

    if (!result.available) {
      logger.info(
        `[podwatch/updater] Up to date (v${currentVersion}, latest: v${result.remoteVersion} via ${result.source}).`
      );
      return;
    }

    // New version available!
    logger.info(
      `[podwatch/updater] Update available: v${currentVersion} → v${result.remoteVersion} (via ${result.source}). Installing...`
    );

    const updateResult = await executeUpdate();

    if (!updateResult.success) {
      logger.error(
        `[podwatch/updater] Update failed: ${updateResult.error}. Continuing with current version.`
      );
      if (updateResult.stderr) {
        console.error("[podwatch/updater] stderr:", updateResult.stderr);
      }
      return;
    }

    logger.info(
      `[podwatch/updater] Update installed successfully. Triggering gateway restart...`
    );

    // Trigger restart — the session will recover automatically
    triggerGatewayRestart();
  } catch (err) {
    // Catch-all: never let the updater crash the plugin
    console.error("[podwatch/updater] Unexpected error:", err);
  }
}
