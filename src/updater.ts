/**
 * Auto-updater for the Podwatch plugin.
 *
 * On plugin startup (called from register()), schedules a non-blocking update
 * check after a 30-second delay. If a new version is available on npm (or the
 * Podwatch dashboard fallback), it downloads via `npm pack`, extracts to the
 * extensions directory, writes a restart sentinel, and triggers a gateway
 * restart via the OS service manager (systemd / launchctl).
 *
 * Safety:
 * - 30s startup delay (don't slow boot)
 * - 24-hour cooldown between checks (cached in a local file)
 * - 5s timeout on all HTTP requests
 * - 120s timeout on npm pack command
 * - All errors caught — never bricks the running plugin
 * - Logs all activity for debugging
 */

import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NPM_REGISTRY_URL = "https://registry.npmjs.org/podwatch/latest";
const CHECK_TIMEOUT_MS = 5_000;
const NPM_PACK_TIMEOUT_MS = 120_000;
const SPAWN_TIMEOUT_MS = 15_000;
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
// Service name resolution (mirrors OpenClaw's constants)
// ---------------------------------------------------------------------------

/**
 * Normalize a gateway profile string. Returns null for empty/default.
 */
function normalizeGatewayProfile(profile: string | undefined): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return null;
  return trimmed;
}

/**
 * Resolve the systemd service name for the gateway.
 */
export function resolveGatewaySystemdServiceName(profile: string | undefined): string {
  const normalized = normalizeGatewayProfile(profile);
  const suffix = normalized ? `-${normalized}` : "";
  if (!suffix) return "openclaw-gateway";
  return `openclaw-gateway${suffix}`;
}

/**
 * Resolve the launchd label for the gateway.
 */
export function resolveGatewayLaunchAgentLabel(profile: string | undefined): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) return "ai.openclaw.gateway";
  return `ai.openclaw.${normalized}`;
}

/**
 * Normalize a systemd unit name. Appends .service if missing.
 */
export function normalizeSystemdUnit(raw: string | undefined, profile: string | undefined): string {
  const unit = raw?.trim();
  if (!unit) return `${resolveGatewaySystemdServiceName(profile)}.service`;
  return unit.endsWith(".service") ? unit : `${unit}.service`;
}

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
  /** SRI integrity hash (e.g. "sha512-<base64>") from npm registry or dashboard. */
  integrityHash?: string;
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
        dist?: { integrity?: string; shasum?: string };
      };
      if (typeof data.version === "string" && data.version) {
        const cmp = compareVersions(currentVersion, data.version);
        // npm registry provides integrity as SRI string at dist.integrity
        const integrity = typeof data.dist?.integrity === "string" ? data.dist.integrity : undefined;
        return {
          available: cmp > 0,
          remoteVersion: data.version,
          source: "npm",
          integrityHash: integrity,
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
// Update execution (npm pack + extract)
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
 * Download the latest podwatch tarball via npm pack.
 * Returns the tarball path on success for integrity verification.
 */
export function downloadTarball(): UpdateResult & { tmpDir?: string } {
  let tmpDir: string | null = null;

  try {
    // 1. Create temp dir for npm pack
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podwatch-update-"));

    // 2. npm pack podwatch (downloads latest from registry)
    const packResult = spawnSync("npm", ["pack", "podwatch", "--pack-destination", tmpDir], {
      encoding: "utf8",
      timeout: NPM_PACK_TIMEOUT_MS,
      cwd: tmpDir,
    });

    if (packResult.error || packResult.status !== 0) {
      return {
        success: false,
        stdout: packResult.stdout,
        stderr: packResult.stderr,
        error: packResult.error?.message ?? `npm pack exited with status ${packResult.status}`,
        tmpDir,
      };
    }

    // Find the tarball filename from stdout (npm pack prints the filename)
    const tarballName = packResult.stdout.trim().split("\n").pop()?.trim();
    if (!tarballName) {
      return {
        success: false,
        stdout: packResult.stdout,
        error: "npm pack did not output a tarball filename",
        tmpDir,
      };
    }

    const tarballPath = path.join(tmpDir, tarballName);

    return {
      success: true,
      stdout: `Downloaded ${tarballName}`,
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
 */
export function installFromTarball(tarballPath: string): UpdateResult {
  const extensionsDir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    ".openclaw",
    "extensions",
    "podwatch"
  );

  try {
    // 1. Clean old dist before extracting
    const distDir = path.join(extensionsDir, "dist");
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }

    // 2. Ensure extensions dir exists
    fs.mkdirSync(extensionsDir, { recursive: true });

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
      return {
        success: false,
        stdout: extractResult.stdout,
        stderr: extractResult.stderr,
        error: extractResult.error?.message ?? `tar extract exited with status ${extractResult.status}`,
      };
    }

    const tarballName = path.basename(tarballPath);
    return {
      success: true,
      stdout: `Updated podwatch from ${tarballName}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download and install the latest podwatch plugin via npm pack + extract.
 * Legacy single-step function — delegates to downloadTarball + installFromTarball.
 *
 * Steps:
 * 1. `npm pack podwatch` in a temp dir to get the tarball
 * 2. Clean old dist in the extensions directory
 * 3. Extract tarball contents to ~/.openclaw/extensions/podwatch/
 */
export function executeUpdate(): UpdateResult {
  const download = downloadTarball();
  try {
    if (!download.success || !download.tarballPath) {
      return {
        success: false,
        stdout: download.stdout,
        stderr: download.stderr,
        error: download.error ?? "Download failed",
      };
    }

    return installFromTarball(download.tarballPath);
  } finally {
    // Cleanup temp dir
    if (download.tmpDir) {
      try {
        fs.rmSync(download.tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway restart via OS service manager
// ---------------------------------------------------------------------------

export interface RestartResult {
  ok: boolean;
  method: string;
  detail?: string;
  tried: string[];
}

/**
 * Trigger a gateway restart using the OS service manager directly.
 * Mirrors OpenClaw's triggerOpenClawRestart logic.
 *
 * Linux: systemctl --user restart <unit> (user first, then system fallback)
 * macOS: launchctl kickstart -k gui/<uid>/<label>
 * Fallback: log a manual restart message
 */
export function triggerGatewayRestart(
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): RestartResult {
  const tried: string[] = [];

  if (process.platform === "linux") {
    const unit = normalizeSystemdUnit(
      process.env.OPENCLAW_SYSTEMD_UNIT,
      process.env.OPENCLAW_PROFILE
    );

    // Try user-level systemctl first
    const userArgs = ["--user", "restart", unit];
    tried.push(`systemctl ${userArgs.join(" ")}`);
    const userRestart = spawnSync("systemctl", userArgs, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    if (!userRestart.error && userRestart.status === 0) {
      logger.info("[podwatch/updater] Gateway restarted via systemctl --user.");
      return { ok: true, method: "systemd", tried };
    }

    // Fall back to system-level systemctl
    const systemArgs = ["restart", unit];
    tried.push(`systemctl ${systemArgs.join(" ")}`);
    const systemRestart = spawnSync("systemctl", systemArgs, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

    if (!systemRestart.error && systemRestart.status === 0) {
      logger.info("[podwatch/updater] Gateway restarted via systemctl (system).");
      return { ok: true, method: "systemd", tried };
    }

    // Both failed
    const detail = [
      `user: ${userRestart.error?.message ?? `exit ${userRestart.status}`}`,
      `system: ${systemRestart.error?.message ?? `exit ${systemRestart.status}`}`,
    ].join("; ");

    logger.error(
      `[podwatch/updater] systemctl restart failed: ${detail}. Please restart the gateway manually.`
    );
    return { ok: false, method: "systemd", detail, tried };
  }

  if (process.platform === "darwin") {
    const label =
      process.env.OPENCLAW_LAUNCHD_LABEL ||
      resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);

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
    logger.error(
      `[podwatch/updater] launchctl restart failed: ${detail}. Please restart the gateway manually.`
    );
    return { ok: false, method: "launchctl", detail, tried };
  }

  // Unsupported platform
  logger.warn(
    `[podwatch/updater] Unsupported platform "${process.platform}" for auto-restart. Please restart the gateway manually.`
  );
  return {
    ok: false,
    method: "unsupported",
    detail: `unsupported platform: ${process.platform}`,
    tried,
  };
}

// ---------------------------------------------------------------------------
// Update options
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  /** Enable auto-update. Default: true. Set false to disable. */
  autoUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// Urgent update trigger (called from transmitter when API signals urgent)
// ---------------------------------------------------------------------------

/** Stored references for triggering urgent updates from the transmitter. */
let urgentUpdateState: {
  currentVersion: string;
  endpoint: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  options: UpdateOptions;
} | null = null;

/**
 * Handle an urgent update signal from the Podwatch API.
 * Bypasses the 24-hour cooldown and triggers an immediate update check.
 * Called by the transmitter when the API response includes { update: { urgent: true } }.
 */
export async function handleUrgentUpdate(
  signalVersion: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
): Promise<void> {
  if (!urgentUpdateState) {
    logger.warn("[podwatch/updater] Urgent update signal received but updater not initialized.");
    return;
  }

  const { currentVersion, endpoint, options } = urgentUpdateState;

  // Skip if autoUpdate is disabled
  if (options.autoUpdate === false) {
    logger.info("[podwatch/updater] Urgent update signal received but auto-update is disabled.");
    return;
  }

  // Skip if the signaled version is not newer
  if (compareVersions(currentVersion, signalVersion) <= 0) {
    logger.info(
      `[podwatch/updater] Urgent update signal for v${signalVersion} but already at v${currentVersion}. Skipping.`
    );
    return;
  }

  logger.info(
    `[podwatch/updater] Urgent update signal received for v${signalVersion}. Bypassing cooldown...`
  );

  // Run the update check immediately (bypasses shouldCheckForUpdate cooldown)
  try {
    const result = await checkForUpdate(currentVersion, endpoint);
    writeCacheTimestamp();

    if (!result || !result.available) {
      logger.info("[podwatch/updater] Urgent check: no update available.");
      return;
    }

    if (!result.integrityHash) {
      logger.warn(
        `[podwatch/updater] Urgent check: no integrity hash for v${result.remoteVersion}. Skipping.`
      );
      return;
    }

    logger.info(
      `[podwatch/updater] Urgent update: v${currentVersion} → v${result.remoteVersion}. Downloading...`
    );

    const download = downloadTarball();
    if (!download.success || !download.tarballPath) {
      logger.error(`[podwatch/updater] Urgent update download failed: ${download.error}`);
      if (download.tmpDir) {
        try { fs.rmSync(download.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      return;
    }

    try {
      const integrity = verifyTarballIntegrity(download.tarballPath, result.integrityHash);
      if (!integrity.valid) {
        logger.error(
          `[podwatch/updater] Urgent update integrity check failed! ` +
            `Expected: ${result.integrityHash}, Got: ${integrity.actualHash ?? integrity.error}.`
        );
        return;
      }

      const installResult = installFromTarball(download.tarballPath);
      if (!installResult.success) {
        logger.error(`[podwatch/updater] Urgent update install failed: ${installResult.error}`);
        return;
      }

      logger.info(
        `[podwatch/updater] Urgent update installed (v${currentVersion} → v${result.remoteVersion}). Restarting...`
      );
      writeRestartSentinel(result.remoteVersion);
      triggerGatewayRestart(logger);
    } finally {
      if (download.tmpDir) {
        try { fs.rmSync(download.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } catch (err) {
    logger.error(`[podwatch/updater] Urgent update error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point (called from register())
// ---------------------------------------------------------------------------

/**
 * Schedule a non-blocking update check 30s after startup.
 * Safe to call synchronously — it sets a timer and returns immediately.
 *
 * Auto-update is on by default. Set autoUpdate: false in plugin config to disable.
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
  // Store state for urgent update triggers from the transmitter
  urgentUpdateState = { currentVersion, endpoint, logger, options };

  const timer = setTimeout(() => {
    void runUpdateCheck(currentVersion, endpoint, logger, options);
  }, STARTUP_DELAY_MS);

  // Don't hold the process open for this timer
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

/**
 * Internal: perform the actual update check + install + restart.
 *
 * Flow:
 * 1. Check autoUpdate opt-in (default false)
 * 2. Respect 24h cooldown
 * 3. Check for newer version (npm → dashboard fallback)
 * 4. Require integrity hash from server (skip if missing)
 * 5. Download tarball via npm pack
 * 6. Verify tarball SHA-256 against server hash
 * 7. Extract and install
 * 8. Write restart sentinel + trigger gateway restart
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

    // 4. Download tarball
    const download = downloadTarball();

    if (!download.success || !download.tarballPath) {
      logger.error(
        `[podwatch/updater] Update failed: ${download.error}. Continuing with current version.`
      );
      if (download.stderr) {
        console.error("[podwatch/updater] stderr:", download.stderr);
      }
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

      // 6. Extract and install
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

      logger.info(
        `[podwatch/updater] Update installed successfully (v${currentVersion} → v${result.remoteVersion}). Writing sentinel and triggering restart...`
      );

      // 7. Write restart sentinel so the gateway knows why it restarted
      writeRestartSentinel(result.remoteVersion);

      // 8. Trigger restart via OS service manager
      triggerGatewayRestart(logger);
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
