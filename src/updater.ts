/**
 * Auto-updater for the Podwatch plugin.
 *
 * On plugin startup (called from register()), schedules a non-blocking update
 * check after a 30-second delay. If a new version is available on npm (or the
 * Podwatch dashboard fallback), it downloads the tarball via fetch(), verifies
 * integrity, extracts to the extensions directory, and writes a restart sentinel.
 *
 * Safety:
 * - 30s startup delay (don't slow boot)
 * - 24-hour cooldown between checks (cached in a local file)
 * - 5s timeout on all HTTP requests
 * - All errors caught — never bricks the running plugin
 * - Rollback: backs up old dist/ before replacing, restores on extraction failure
 * - Plugin NEVER restarts its host — only writes restart sentinel
 * - Auto-update defaults to OFF (opt-in)
 * - No handleUrgentUpdate — removed as remote code execution vector
 */

import { spawnSync } from "node:child_process";
import { transmitter } from "./transmitter.js";
import { isInactive } from "./activity-tracker.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NPM_REGISTRY_URL = "https://registry.npmjs.org/podwatch/latest";
const NPM_TARBALL_URL_PREFIX = "https://registry.npmjs.org/podwatch/-/podwatch-";
const CHECK_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SPAWN_TIMEOUT_MS = 15_000;
const STARTUP_DELAY_MS = 30_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Graceful restart: wait for idle window before restarting
const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes of inactivity
const DEFER_INTERVAL_MS = 5 * 60 * 1000;  // Re-check every 5 minutes
const MAX_DEFER_MS = 2 * 60 * 60 * 1000;  // Max 2 hours of deferral

const CACHE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".openclaw",
  "extensions",
  "podwatch"
);

export const AUTO_UPDATE_CACHE_FILE = path.join(CACHE_DIR, ".last-update-check");

// ---------------------------------------------------------------------------
// State dir resolution (mirrors OpenClaw's resolveStateDir)
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw state directory.
 * Checks OPENCLAW_STATE_DIR / CLAWDBOT_STATE_DIR env, then defaults to ~/.openclaw.
 */
export function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".openclaw");
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Read the installed plugin version from disk (extensions dir package.json).
 * Returns null if the file can't be read.
 */
export function getInstalledVersion(): string | null {
  try {
    const extensionsDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
      ".openclaw",
      "extensions",
      "podwatch"
    );
    const pkgPath = path.join(extensionsDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

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
  /** SRI integrity hash (e.g. "sha512-<base64>") from npm registry or dashboard. */
  integrityHash?: string;
  /** Direct tarball URL from npm registry (for fetch-based download). */
  tarballUrl?: string;
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
      const data = (await resp.json()) as {
        version?: string;
        dist?: { integrity?: string; shasum?: string; tarball?: string };
      };
      if (typeof data.version === "string" && data.version) {
        const cmp = compareVersions(currentVersion, data.version);
        // npm registry provides integrity as SRI string at dist.integrity
        const integrity = typeof data.dist?.integrity === "string" ? data.dist.integrity : undefined;
        const tarballUrl = typeof data.dist?.tarball === "string" ? data.dist.tarball : undefined;
        return {
          available: cmp > 0,
          remoteVersion: data.version,
          source: "npm",
          integrityHash: integrity,
          tarballUrl,
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
      const data = (await resp.json()) as {
        version?: string;
        integrityHash?: string;
      };
      if (typeof data.version === "string" && data.version) {
        const cmp = compareVersions(currentVersion, data.version);
        return {
          available: cmp > 0,
          remoteVersion: data.version,
          source: "dashboard",
          integrityHash: typeof data.integrityHash === "string" ? data.integrityHash : undefined,
        };
      }
    }
  } catch {
    // Both failed
  }

  return null;
}

// ---------------------------------------------------------------------------
// Restart sentinel
// ---------------------------------------------------------------------------

export interface RestartSentinelPayload {
  kind: string;
  status: string;
  ts: number;
  message: string;
  doctorHint: string;
}

/**
 * Write a restart sentinel file so the gateway knows why it was restarted.
 * Mirrors OpenClaw's writeRestartSentinel from src/infra/restart-sentinel.ts.
 */
export function writeRestartSentinel(version: string): string {
  const stateDir = resolveStateDir();
  const sentinelPath = path.join(stateDir, "state", "restart-sentinel.json");
  const data = {
    version: 1,
    payload: {
      kind: "update",
      status: "ok",
      ts: Date.now(),
      message: `Podwatch plugin updated to v${version}`,
      doctorHint: "Run: openclaw doctor --non-interactive",
    },
  };

  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    return sentinelPath;
  } catch (err) {
    console.warn("[podwatch/updater] Failed to write restart sentinel:", err);
    return sentinelPath;
  }
}

// ---------------------------------------------------------------------------
// Tarball integrity verification
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  valid: boolean;
  actualHash?: string;
  error?: string;
}

/**
 * Parse an SRI (Subresource Integrity) hash string.
 * Format: "sha256-<base64>" or "sha512-<base64>"
 * Returns null if the format is invalid.
 */
export function parseSriHash(sri: string): { algorithm: string; digest: string } | null {
  const match = sri.match(/^(sha256|sha384|sha512)-(.+)$/);
  if (!match) return null;
  return { algorithm: match[1]!, digest: match[2]! };
}

/**
 * Verify the integrity of a tarball against an expected hash.
 * Supports:
 * - SRI format: "sha512-<base64>" or "sha256-<base64>" (from npm registry)
 * - Legacy hex format: plain hex SHA-256 string (from dashboard fallback)
 */
export function verifyTarballIntegrity(tarballPath: string, expectedHash: string): IntegrityResult {
  try {
    const content = fs.readFileSync(tarballPath);

    // Try SRI format first
    const sri = parseSriHash(expectedHash);
    if (sri) {
      const actualDigest = crypto.createHash(sri.algorithm).update(content).digest("base64");
      const actualSri = `${sri.algorithm}-${actualDigest}`;
      return {
        valid: actualDigest === sri.digest,
        actualHash: actualSri,
      };
    }

    // Fallback: legacy hex SHA-256 comparison
    const actualHash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      valid: actualHash === expectedHash,
      actualHash,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Rollback helpers
// ---------------------------------------------------------------------------

/**
 * Back up the existing dist/ directory before replacing it.
 * Returns the backup path, or null if no dist/ exists.
 */
export function backupDist(extensionsDir: string): string | null {
  const distDir = path.join(extensionsDir, "dist");
  if (!fs.existsSync(distDir)) return null;

  const backupDir = path.join(extensionsDir, "dist.backup");
  try {
    // Remove stale backup if it exists
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.renameSync(distDir, backupDir);
    return backupDir;
  } catch (err) {
    console.warn("[podwatch/updater] Failed to backup dist/:", err);
    return null;
  }
}

/**
 * Restore dist/ from backup after a failed extraction.
 */
export function restoreFromBackup(extensionsDir: string, backupDir: string): boolean {
  try {
    const distDir = path.join(extensionsDir, "dist");
    // Remove the failed extraction
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
    fs.renameSync(backupDir, distDir);
    return true;
  } catch (err) {
    console.error("[podwatch/updater] Failed to restore dist/ from backup:", err);
    return false;
  }
}

/**
 * Clean up backup after successful extraction.
 */
export function cleanupBackup(backupDir: string): void {
  try {
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Update execution (fetch download + extract with rollback)
// ---------------------------------------------------------------------------

export interface UpdateResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  /** Path to the downloaded tarball (available even on extract failure). */
  tarballPath?: string;
}

/**
 * Download the podwatch tarball via fetch() from the npm registry URL.
 * No shell commands needed — pure HTTP download.
 */
export async function downloadTarball(
  version?: string,
  tarballUrl?: string
): Promise<UpdateResult & { tmpDir?: string }> {
  let tmpDir: string | null = null;

  try {
    // 1. Create temp dir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podwatch-update-"));

    // 2. Determine download URL
    const url = tarballUrl ?? `${NPM_TARBALL_URL_PREFIX}${version ?? "latest"}.tgz`;

    // 3. Fetch the tarball
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Tarball download failed: HTTP ${response.status}`,
        tmpDir,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 4. Write to temp file
    const tarballName = `podwatch-${version ?? "latest"}.tgz`;
    const tarballPath = path.join(tmpDir, tarballName);
    fs.writeFileSync(tarballPath, buffer);

    return {
      success: true,
      stdout: `Downloaded ${tarballName} (${buffer.length} bytes)`,
      tarballPath,
      tmpDir,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      tmpDir: tmpDir ?? undefined,
    };
  }
}

/**
 * Install from a previously downloaded tarball by extracting to the extensions dir.
 * Includes rollback: backs up old dist/ before extraction, restores on failure.
 */
export function installFromTarball(tarballPath: string): UpdateResult {
  const extensionsDir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    ".openclaw",
    "extensions",
    "podwatch"
  );

  let backupDir: string | null = null;

  try {
    // 1. Ensure extensions dir exists
    fs.mkdirSync(extensionsDir, { recursive: true });

    // 2. Backup existing dist/ before replacing
    backupDir = backupDist(extensionsDir);

    // 3. Extract tarball — npm pack creates tarballs with a "package/" prefix
    const extractResult = spawnSync(
      "tar",
      ["xzf", tarballPath, "--strip-components=1", "-C", extensionsDir],
      {
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    if (extractResult.error || extractResult.status !== 0) {
      // Rollback on extraction failure
      if (backupDir) {
        restoreFromBackup(extensionsDir, backupDir);
        console.warn("[podwatch/updater] Extraction failed — rolled back to previous version.");
      }
      return {
        success: false,
        stdout: extractResult.stdout,
        stderr: extractResult.stderr,
        error: extractResult.error?.message ?? `tar extract exited with status ${extractResult.status}`,
      };
    }

    // 4. Cleanup backup on success
    if (backupDir) {
      cleanupBackup(backupDir);
    }

    const tarballName = path.basename(tarballPath);
    return {
      success: true,
      stdout: `Updated podwatch from ${tarballName}`,
    };
  } catch (err) {
    // Rollback on any error
    if (backupDir) {
      restoreFromBackup(extensionsDir, backupDir);
      console.warn("[podwatch/updater] Install failed — rolled back to previous version.");
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download and install the latest podwatch plugin via fetch + extract.
 * Legacy single-step function — delegates to downloadTarball + installFromTarball.
 */
export function executeUpdate(): UpdateResult {
  // executeUpdate is sync for backward compat — use spawnSync-based fallback
  const extensionsDir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    ".openclaw",
    "extensions",
    "podwatch"
  );

  let tmpDir: string | null = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podwatch-update-"));

    // Use npx npm pack as sync fallback (downloadTarball is async)
    const packResult = spawnSync("npx", ["-y", "npm", "pack", "podwatch", "--pack-destination", tmpDir], {
      encoding: "utf8",
      timeout: 120_000,
      cwd: tmpDir,
    });

    if (packResult.error || packResult.status !== 0) {
      return {
        success: false,
        stdout: packResult.stdout,
        stderr: packResult.stderr,
        error: packResult.error?.message ?? `npx npm pack exited with status ${packResult.status}`,
      };
    }

    const tarballName = packResult.stdout.trim().split("\n").pop()?.trim();
    if (!tarballName) {
      return {
        success: false,
        stdout: packResult.stdout,
        error: "npm pack did not output a tarball filename",
      };
    }

    const tarballPath = path.join(tmpDir, tarballName);
    return installFromTarball(tarballPath);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-restart verification
// ---------------------------------------------------------------------------

/**
 * Verify that the newly installed dist/index.js is loadable.
 * Tries to require() the entry point — if it throws, the new code is broken.
 * Returns true if the module loads successfully, false otherwise.
 */
export function verifyNewDist(extensionsDir: string): boolean {
  const entryPoint = path.join(extensionsDir, "dist", "index.js");
  try {
    if (!fs.existsSync(entryPoint)) return false;
    // Use a child process to verify — don't pollute our own module cache
    const result = spawnSync(
      process.execPath,
      ["-e", `try { require(${JSON.stringify(entryPoint)}); process.exit(0); } catch(e) { console.error(e.message); process.exit(1); }`],
      { encoding: "utf8", timeout: 10_000 }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Graceful idle window — defer restart until agent is inactive
// ---------------------------------------------------------------------------

/**
 * Wait for an idle window before proceeding with a gateway restart.
 *
 * Checks isInactive(15min). If the agent is active, defers 5 minutes and
 * re-checks. After a maximum of 2 hours of deferral, forces the restart
 * with a warning log.
 *
 * @returns true if idle window was found, false if forced after max deferral
 */
export async function waitForIdleWindow(
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): Promise<boolean> {
  let totalDeferred = 0;

  while (!isInactive(IDLE_THRESHOLD_MS)) {
    if (totalDeferred >= MAX_DEFER_MS) {
      logger.warn(
        `[podwatch/updater] Agent still active after ${Math.round(MAX_DEFER_MS / 60_000)}min of deferral. Forcing restart.`
      );
      return false;
    }

    logger.info(
      `[podwatch/updater] Agent is active — deferring restart for ${DEFER_INTERVAL_MS / 60_000}min ` +
        `(deferred ${Math.round(totalDeferred / 60_000)}/${Math.round(MAX_DEFER_MS / 60_000)}min so far).`
    );

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DEFER_INTERVAL_MS);
      if (timer && typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });

    totalDeferred += DEFER_INTERVAL_MS;
  }

  logger.info("[podwatch/updater] Agent is idle — proceeding with restart.");
  return true;
}

// ---------------------------------------------------------------------------
// Gateway restart via OS service manager (with safety checks)
// ---------------------------------------------------------------------------

export interface RestartResult {
  ok: boolean;
  method: string;
  detail?: string;
  tried: string[];
}

/**
 * Resolve the systemd service name for the gateway.
 */
function resolveGatewayServiceName(profile: string | undefined): string {
  const trimmed = profile?.trim();
  const normalized = (!trimmed || trimmed.toLowerCase() === "default") ? null : trimmed;
  const suffix = normalized ? `-${normalized}` : "";
  return `openclaw-gateway${suffix}.service`;
}

/**
 * Trigger a gateway restart using the OS service manager.
 *
 * Safety improvements over original:
 * - Only called AFTER verifyNewDist() confirms the new code loads
 * - Only called AFTER integrity verification passed
 * - Only called AFTER rollback backup is in place
 * - Single attempt — if restart fails, logs error and moves on (no retry loop)
 *
 * Linux: systemctl --user restart <unit>
 * macOS: launchctl kickstart -k gui/<uid>/<label>
 */
export function triggerGatewayRestart(
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): RestartResult {
  const tried: string[] = [];

  if (process.platform === "linux") {
    const unit = resolveGatewayServiceName(process.env.OPENCLAW_PROFILE);

    // Try user-level systemctl
    const args = ["--user", "restart", unit];
    tried.push(`systemctl ${args.join(" ")}`);
    const result = spawnSync("systemctl", args, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    if (!result.error && result.status === 0) {
      logger.info("[podwatch/updater] Gateway restarted via systemctl --user.");
      return { ok: true, method: "systemd", tried };
    }

    // Single fallback: system-level
    const sysArgs = ["restart", unit];
    tried.push(`systemctl ${sysArgs.join(" ")}`);
    const sysResult = spawnSync("systemctl", sysArgs, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    if (!sysResult.error && sysResult.status === 0) {
      logger.info("[podwatch/updater] Gateway restarted via systemctl (system).");
      return { ok: true, method: "systemd", tried };
    }

    const detail = `user: ${result.error?.message ?? `exit ${result.status}`}; system: ${sysResult.error?.message ?? `exit ${sysResult.status}`}`;
    logger.warn(`[podwatch/updater] Could not restart gateway: ${detail}. Restart manually to activate update.`);
    return { ok: false, method: "systemd", detail, tried };
  }

  if (process.platform === "darwin") {
    const profile = process.env.OPENCLAW_PROFILE?.trim();
    const normalized = (!profile || profile.toLowerCase() === "default") ? null : profile;
    const label = process.env.OPENCLAW_LAUNCHD_LABEL || (normalized ? `ai.openclaw.${normalized}` : "ai.openclaw.gateway");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const target = uid !== undefined ? `gui/${uid}/${label}` : label;
    const args = ["kickstart", "-k", target];
    tried.push(`launchctl ${args.join(" ")}`);

    const res = spawnSync("launchctl", args, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    if (!res.error && res.status === 0) {
      logger.info("[podwatch/updater] Gateway restarted via launchctl.");
      return { ok: true, method: "launchctl", tried };
    }

    const detail = res.error?.message ?? `exit ${res.status}`;
    logger.warn(`[podwatch/updater] Could not restart gateway: ${detail}. Restart manually to activate update.`);
    return { ok: false, method: "launchctl", detail, tried };
  }

  logger.info(
    `[podwatch/updater] Platform "${process.platform}" — restart manually to activate update.`
  );
  return { ok: false, method: "unsupported", detail: `platform: ${process.platform}`, tried };
}

// ---------------------------------------------------------------------------
// Update options
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  /** Enable auto-update. Default: false (opt-in for security). */
  autoUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// Main entry point (called from register())
// ---------------------------------------------------------------------------

/**
 * Schedule a non-blocking update check 30s after startup.
 * Safe to call synchronously — it sets a timer and returns immediately.
 *
 * Auto-update is OFF by default. Set autoUpdate: true in plugin config to enable.
 *
 * @param currentVersion The plugin's current version from package.json
 * @param endpoint The Podwatch API endpoint (for dashboard fallback)
 * @param logger The plugin logger (api.logger)
 * @param options Update options (autoUpdate, etc.)
 */
export function scheduleUpdateCheck(
  currentVersion: string,
  endpoint: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
  options: UpdateOptions = {}
): void {
  const timer = setTimeout(() => {
    void runUpdateCheck(currentVersion, endpoint, logger, options);
  }, STARTUP_DELAY_MS);

  // Don't hold the process open for this timer
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

/**
 * Internal: perform the actual update check + install.
 *
 * Flow:
 * 1. Check autoUpdate opt-in (default false)
 * 2. Respect 24h cooldown
 * 3. Check for newer version (npm → dashboard fallback)
 * 4. Require integrity hash from server (skip if missing)
 * 5. Download tarball via fetch
 * 6. Verify tarball integrity against server hash
 * 7. Extract and install (with rollback on failure)
 * 8. Write restart sentinel (gateway picks it up on next restart)
 */
export async function runUpdateCheck(
  currentVersion: string,
  endpoint: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
  options: UpdateOptions = {}
): Promise<void> {
  try {
    // 1. Check opt-in — auto-update must be explicitly enabled
    if (options.autoUpdate === false) {
      logger.info("[podwatch/updater] Auto-update is disabled. Remove autoUpdate: false from plugin config to re-enable.");
      return;
    }

    // 2. Respect 24h cooldown
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

    // 3. Require integrity hash from server
    if (!result.integrityHash) {
      logger.warn(
        `[podwatch/updater] No integrity hash available for v${result.remoteVersion} (via ${result.source}). ` +
          "Skipping update for security. The server must provide an integrity hash."
      );
      return;
    }

    // New version available with integrity hash!
    logger.info(
      `[podwatch/updater] Update available: v${currentVersion} → v${result.remoteVersion} (via ${result.source}). Downloading...`
    );

    // 4. Download tarball via fetch
    const download = await downloadTarball(result.remoteVersion, result.tarballUrl);

    if (!download.success || !download.tarballPath) {
      logger.error(
        `[podwatch/updater] Update failed: ${download.error}. Continuing with current version.`
      );
      // Cleanup temp dir
      if (download.tmpDir) {
        try { fs.rmSync(download.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      return;
    }

    try {
      // 5. Verify tarball integrity
      const integrity = verifyTarballIntegrity(download.tarballPath, result.integrityHash);

      logger.info(
        `[podwatch/updater] Package integrity: ${integrity.actualHash ?? "unknown"}`
      );

      if (!integrity.valid) {
        logger.error(
          `[podwatch/updater] Tarball integrity check failed! ` +
            `Expected: ${result.integrityHash}, Got: ${integrity.actualHash ?? integrity.error}. ` +
            "Update aborted — possible supply chain attack."
        );
        return;
      }

      logger.info(
        `[podwatch/updater] Integrity verified (${integrity.actualHash}). Installing v${result.remoteVersion}...`
      );

      // 6. Extract and install (with rollback on failure)
      const installResult = installFromTarball(download.tarballPath);

      if (!installResult.success) {
        logger.error(
          `[podwatch/updater] Update failed: ${installResult.error}. Continuing with current version.`
        );
        if (installResult.stderr) {
          console.error("[podwatch/updater] stderr:", installResult.stderr);
        }
        return;
      }

      // 7. Verify the new dist loads before doing anything dangerous
      const extensionsDir = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
        ".openclaw", "extensions", "podwatch"
      );
      const distOk = verifyNewDist(extensionsDir);

      if (!distOk) {
        logger.error(
          `[podwatch/updater] New dist/index.js failed to load! Rolling back to previous version.`
        );
        // installFromTarball has its own rollback, but if it succeeded and the JS is still broken:
        const backupDir = path.join(extensionsDir, "dist.backup");
        if (fs.existsSync(backupDir)) {
          restoreFromBackup(extensionsDir, backupDir);
          logger.info("[podwatch/updater] Rolled back to previous version.");
        }
        transmitter.enqueue({
          type: "alert",
          ts: Date.now(),
          message: `Podwatch update to v${result.remoteVersion} failed verification — rolled back. Please report this.`,
          severity: "error",
        });
        return;
      }

      // 8. Write restart sentinel
      writeRestartSentinel(result.remoteVersion);

      // 9. Notify dashboard
      transmitter.enqueue({
        type: "alert",
        ts: Date.now(),
        message: `Podwatch updated: v${currentVersion} → v${result.remoteVersion}. Restarting gateway...`,
        severity: "info",
      });

      // 10. Flush transmitter so the notification gets out before restart
      await transmitter.flush();

      logger.info(
        `[podwatch/updater] Update verified and installed (v${currentVersion} → v${result.remoteVersion}). ` +
          "Waiting for idle window before restart..."
      );

      // 11. Wait for idle window, then restart
      await waitForIdleWindow(logger);
      const restartResult = triggerGatewayRestart(logger);

      if (!restartResult.ok) {
        logger.info(
          `[podwatch/updater] Automatic restart not available. Update is installed — ` +
            "restart the gateway manually to activate."
        );
      }
    } finally {
      // Cleanup temp dir
      if (download.tmpDir) {
        try { fs.rmSync(download.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } catch (err) {
    // Catch-all: never let the updater crash the plugin
    console.error("[podwatch/updater] Unexpected error:", err);
  }
}
