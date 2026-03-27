/**
 * Tests for the auto-update system.
 *
 * Tests cover:
 * - Version comparison logic
 * - 24-hour cooldown caching
 * - NPM registry version check
 * - Dashboard API fallback version check
 * - Update execution via npm pack + extract
 * - Rollback mechanism on extraction failure
 * - Restart sentinel writing
 * - Error handling (network failures, bad JSON, timeouts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockSpawnSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// Mock fs for cache file and sentinel operations
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdtempSync = vi.fn();
const mockRmSync = vi.fn();
const mockRenameSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

// Mock os
vi.mock("node:os", () => ({
  default: {
    tmpdir: () => "/tmp",
    homedir: () => "/home/testuser",
  },
  tmpdir: () => "/tmp",
  homedir: () => "/home/testuser",
}));

// Mock transmitter
const mockEnqueue = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
vi.mock("./transmitter.js", () => ({
  transmitter: {
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
    flush: (...args: unknown[]) => mockFlush(...args),
  },
}));

// Mock activity-tracker — controllable via mockIsInactive
const mockIsInactive = vi.fn().mockReturnValue(true); // Default: always idle
vi.mock("./activity-tracker.js", () => ({
  isInactive: (...args: unknown[]) => mockIsInactive(...args),
}));

// Mock global fetch (Bun doesn't have vi.stubGlobal)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as any;

/**
 * Bun's vi.resetAllMocks() / vi.clearAllMocks() do NOT clear the
 * mockReturnValueOnce queue. We must call .mockReset() on each mock.
 */
function resetMocks() {
  mockSpawnSync.mockReset();
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockMkdirSync.mockReset();
  mockExistsSync.mockReset();
  mockMkdtempSync.mockReset();
  mockRmSync.mockReset();
  mockRenameSync.mockReset();
  mockFetch.mockReset();
  mockIsInactive.mockReset().mockReturnValue(true); // Default: always idle
}

// Now import the module under test
import {
  compareVersions,
  checkForUpdate,
  executeUpdate,
  shouldCheckForUpdate,
  writeCacheTimestamp,
  writeRestartSentinel,
  resolveStateDir,
  runUpdateCheck,
  verifyTarballIntegrity,
  parseSriHash,
  scheduleUpdateCheck,
  AUTO_UPDATE_CACHE_FILE,
  backupDist,
  restoreFromBackup,
  cleanupBackup,
  installFromTarball,
  downloadTarball,
  verifyNewDist,
  waitForIdleWindow,
  triggerGatewayRestart,
  acquireUpdateLock,
  releaseUpdateLock,
} from "./updater.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as Response;
}

function binaryResponse(data: Buffer, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    headers: new Headers(),
  } as Response;
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns positive when remote is newer (patch)", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeGreaterThan(0);
  });

  it("returns positive when remote is newer (minor)", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBeGreaterThan(0);
  });

  it("returns positive when remote is newer (major)", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeGreaterThan(0);
  });

  it("returns negative when local is newer", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeLessThan(0);
  });

  it("handles multi-digit version components", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeGreaterThan(0);
  });

  it("handles versions with v prefix", () => {
    expect(compareVersions("v1.0.0", "v1.0.1")).toBeGreaterThan(0);
  });
});

describe("shouldCheckForUpdate", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("returns true when cache file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(shouldCheckForUpdate()).toBe(true);
  });

  it("returns true when cache timestamp is older than 24 hours", () => {
    mockExistsSync.mockReturnValue(true);
    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    mockReadFileSync.mockReturnValue(JSON.stringify({ lastCheckTs: oldTime }));
    expect(shouldCheckForUpdate()).toBe(true);
  });

  it("returns false when cache timestamp is within 24 hours", () => {
    mockExistsSync.mockReturnValue(true);
    const recentTime = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
    mockReadFileSync.mockReturnValue(JSON.stringify({ lastCheckTs: recentTime }));
    expect(shouldCheckForUpdate()).toBe(false);
  });

  it("returns true when cache file is corrupted", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");
    expect(shouldCheckForUpdate()).toBe(true);
  });

  it("returns true when readFileSync throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(shouldCheckForUpdate()).toBe(true);
  });
});

describe("writeCacheTimestamp", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("writes JSON with lastCheckTs", () => {
    writeCacheTimestamp();
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".openclaw/extensions/podwatch"),
      { recursive: true }
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      AUTO_UPDATE_CACHE_FILE,
      expect.stringContaining("lastCheckTs")
    );
  });

  it("does not throw on write error", () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error("EPERM");
    });
    expect(() => writeCacheTimestamp()).not.toThrow();
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("returns newer version from npm registry", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0" }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({ available: true, remoteVersion: "1.1.0", source: "npm" });
  });

  it("returns null when versions match (npm)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({ available: false, remoteVersion: "1.0.0", source: "npm" });
  });

  it("returns null when local is ahead of npm", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "0.9.0" }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({ available: false, remoteVersion: "0.9.0", source: "npm" });
  });

  it("falls back to dashboard API when npm fails", async () => {
    // npm fails
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.2.0" }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({ available: true, remoteVersion: "1.2.0", source: "dashboard" });
  });

  it("returns null when both sources fail", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toBeNull();
  });

  it("calls npm registry with correct URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

    await checkForUpdate("1.0.0", "https://podwatch.app/api");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/podwatch/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("calls dashboard API with correct URL", async () => {
    // npm fails
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

    await checkForUpdate("1.0.0", "https://podwatch.app/api");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://podwatch.app/api/plugin-version",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("handles malformed npm response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ name: "podwatch" })); // no version field
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0" }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({ available: true, remoteVersion: "1.1.0", source: "dashboard" });
  });
});

describe("executeUpdate", () => {
  beforeEach(() => {
    resetMocks();
    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc123");
    // Default: dist dir does not exist
    mockExistsSync.mockReturnValue(false);
  });

  it("runs npm pack and extracts the tarball", () => {
    // npm pack succeeds
    mockSpawnSync
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "podwatch-1.1.0.tgz\n",
        stderr: "",
      })
      // tar extract succeeds
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "",
        stderr: "",
      });

    const result = executeUpdate();
    expect(result.success).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "npx",
      ["-y", "npm", "pack", "podwatch", "--pack-destination", "/tmp/podwatch-update-abc123"],
      expect.objectContaining({ timeout: 120_000 })
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tar",
      expect.arrayContaining(["xzf", "/tmp/podwatch-update-abc123/podwatch-1.1.0.tgz"]),
      expect.any(Object)
    );
  });

  it("returns failure when npm pack fails with error", () => {
    mockSpawnSync.mockReturnValueOnce({
      error: new Error("npm not found"),
      status: 1,
      stdout: "",
      stderr: "command not found",
    });

    const result = executeUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain("npm not found");
  });

  it("returns failure when npm pack exits non-zero", () => {
    mockSpawnSync.mockReturnValueOnce({
      error: null,
      status: 1,
      stdout: "",
      stderr: "npm ERR! 404",
    });

    const result = executeUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain("status 1");
  });

  it("returns failure when npm pack outputs empty stdout", () => {
    mockSpawnSync.mockReturnValueOnce({
      error: null,
      status: 0,
      stdout: "   \n",
      stderr: "",
    });

    const result = executeUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain("tarball filename");
  });

  it("returns failure when tar extract fails", () => {
    // npm pack succeeds
    mockSpawnSync
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "podwatch-1.1.0.tgz\n",
        stderr: "",
      })
      // tar extract fails
      .mockReturnValueOnce({
        error: new Error("tar failed"),
        status: 1,
        stdout: "",
        stderr: "error extracting",
      });

    const result = executeUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain("tar failed");
  });

  it("cleans up temp dir after success", () => {
    // npm pack succeeds
    mockSpawnSync
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "podwatch-1.1.0.tgz\n",
        stderr: "",
      })
      // tar extract succeeds
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "",
        stderr: "",
      });

    executeUpdate();
    // rmSync called for cleanup (temp dir) — may also be called for dist
    expect(mockRmSync).toHaveBeenCalledWith(
      "/tmp/podwatch-update-abc123",
      { recursive: true, force: true }
    );
  });
});

describe("writeRestartSentinel", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    resetMocks();
    savedEnv = {
      HOME: process.env.HOME,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
    };
    process.env.HOME = "/home/testuser";
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("writes sentinel JSON with correct structure", () => {
    writeRestartSentinel("1.2.0");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("state"),
      { recursive: true }
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("restart-sentinel.json"),
      expect.any(String),
      "utf-8"
    );

    // Parse the written JSON
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.version).toBe(1);
    expect(parsed.payload.kind).toBe("update");
    expect(parsed.payload.status).toBe("ok");
    expect(parsed.payload.message).toBe("Podwatch plugin updated to v1.2.0");
    expect(parsed.payload.doctorHint).toBe("Run: openclaw doctor --non-interactive");
    expect(typeof parsed.payload.ts).toBe("number");
  });

  it("returns the sentinel path", () => {
    const result = writeRestartSentinel("1.2.0");
    expect(result).toContain("restart-sentinel.json");
  });

  it("does not throw on write error", () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error("EPERM");
    });
    expect(() => writeRestartSentinel("1.2.0")).not.toThrow();
  });

  it("respects OPENCLAW_STATE_DIR env var", () => {
    process.env.OPENCLAW_STATE_DIR = "/custom/state";
    writeRestartSentinel("1.2.0");

    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).toContain("/custom/state");
  });
});

describe("resolveStateDir", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
    };
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("returns OPENCLAW_STATE_DIR when set", () => {
    process.env.OPENCLAW_STATE_DIR = "/custom/state";
    expect(resolveStateDir()).toBe("/custom/state");
  });

  it("returns CLAWDBOT_STATE_DIR when set", () => {
    process.env.CLAWDBOT_STATE_DIR = "/legacy/state";
    expect(resolveStateDir()).toBe("/legacy/state");
  });

  it("defaults to ~/.openclaw", () => {
    const result = resolveStateDir();
    expect(result).toContain(".openclaw");
  });
});

// ---------------------------------------------------------------------------
// Auto-update opt-in (autoUpdate config option)
// ---------------------------------------------------------------------------

describe("runUpdateCheck — autoUpdate opt-in", () => {
  beforeEach(() => {
    resetMocks();
    // Make shouldCheckForUpdate() return true (no cache file)
    mockExistsSync.mockReturnValue(false);
  });

  it("does NOT run when autoUpdate is explicitly false", async () => {
    const logger = mockLogger();
    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: false });

    // Should not even call fetch
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Auto-update is disabled")
    );
  });

  it("runs when autoUpdate is undefined (default is now true)", async () => {
    const logger = mockLogger();
    // npm returns same version (no update)
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, {});

    // autoUpdate defaults to true, so it should proceed and call fetch
    expect(mockFetch).toHaveBeenCalled();
  });

  it("runs when autoUpdate is explicitly true", async () => {
    const logger = mockLogger();
    // npm returns same version (no update)
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should have called fetch (tried to check)
    expect(mockFetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tarball integrity verification
// ---------------------------------------------------------------------------

describe("verifyTarballIntegrity", () => {
  it("returns true when tarball hash matches expected hash", () => {
    // Create a known buffer and its SHA-256
    const content = Buffer.from("test tarball content");
    const crypto = require("node:crypto");
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");

    // Mock fs.readFileSync to return our known content
    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", expectedHash);
    expect(result.valid).toBe(true);
    expect(result.actualHash).toBe(expectedHash);
  });

  it("returns false when tarball hash does NOT match expected hash", () => {
    const content = Buffer.from("test tarball content");
    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", "badhash123");
    expect(result.valid).toBe(false);
    expect(result.actualHash).toBeTruthy();
    expect(result.actualHash).not.toBe("badhash123");
  });

  it("returns false when readFileSync throws", () => {
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const result = verifyTarballIntegrity("/tmp/nonexistent.tgz", "somehash");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// Full update flow with integrity verification
// ---------------------------------------------------------------------------

describe("runUpdateCheck — integrity verification", () => {
  beforeEach(() => {
    resetMocks();
    // Make shouldCheckForUpdate() return true (no cache file)
    mockExistsSync.mockReturnValue(false);
  });

  it("verifies tarball integrity against server-provided SRI hash", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("fake tarball");
    const tarballDigest = crypto.createHash("sha512").update(tarballContent).digest("base64");
    const sriHash = `sha512-${tarballDigest}`;

    // npm registry fails → fallback to dashboard
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard returns version + integrityHash (SRI format)
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0", integrityHash: sriHash }));
    // downloadTarball fetches the tarball
    mockFetch.mockResolvedValueOnce(binaryResponse(tarballContent));

    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");

    // tar extract succeeds
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    // Mock reading tarball for hash verification
    mockReadFileSync.mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should have logged the integrity hash
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`sha512-${tarballDigest}`)
    );
  });

  it("aborts update when tarball hash does NOT match server hash", async () => {
    const logger = mockLogger();

    // npm registry fails → fallback to dashboard
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard returns version + integrityHash (SRI format, won't match tarball)
    mockFetch.mockResolvedValueOnce(jsonResponse({
      version: "1.1.0",
      integrityHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }));
    // downloadTarball fetches the tarball
    mockFetch.mockResolvedValueOnce(binaryResponse(Buffer.from("different content")));

    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");

    // Mock reading tarball — content won't match the SRI hash
    mockReadFileSync.mockReturnValueOnce(Buffer.from("different content"));

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should log integrity error
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("integrity")
    );
    // Should NOT have called tar extract (update aborted before extraction)
    const tarCalls = mockSpawnSync.mock.calls.filter(
      (call: unknown[]) => call[0] === "tar"
    );
    expect(tarCalls).toHaveLength(0);
  });

  it("skips update with warning when server provides no integrity hash", async () => {
    const logger = mockLogger();

    // npm registry returns update (no dist.integrity — edge case)
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0" }));

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should log warning about missing hash
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No integrity hash")
    );
  });

  it("verifies new dist, writes sentinel, and triggers graceful restart", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("update content");
    const tarballDigest = crypto.createHash("sha512").update(tarballContent).digest("base64");
    const sriHash = `sha512-${tarballDigest}`;

    // npm registry fails → dashboard has hash
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0", integrityHash: sriHash }));
    // downloadTarball fetches the tarball
    mockFetch.mockResolvedValueOnce(binaryResponse(tarballContent));

    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");

    // existsSync: return true for dist/backup/index.js, but false for lock file
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".update-lock")) return false;
      return true;
    });

    // spawnSync calls in order:
    // 1. installFromTarball → tar extract succeeds
    // 2. verifyNewDist → child process check succeeds
    // 3. triggerGatewayRestart → systemctl --user restart succeeds
    mockSpawnSync
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })  // tar
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })  // verifyNewDist
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" }); // systemctl

    // readFileSync calls in order:
    // 1. shouldCheckForUpdate → read cache file (throw = no cache = should check)
    // 2. verifyTarballIntegrity → read tarball for hash
    mockReadFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT"); })
      .mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should have written sentinel (among other writeFileSync calls like cache timestamp)
    const sentinelCall = mockWriteFileSync.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("restart-sentinel.json")
    );
    expect(sentinelCall).toBeTruthy();

    // Should have triggered restart (systemctl call)
    const restartCalls = mockSpawnSync.mock.calls.filter(
      (call: unknown[]) => call[0] === "systemctl" || call[0] === "launchctl"
    );
    expect(restartCalls.length).toBeGreaterThanOrEqual(1);

    // Should have sent dashboard notification
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "alert", severity: "info" })
    );

    // Should log success
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("verified and installed")
    );
  });
});

// ---------------------------------------------------------------------------
// SRI hash parsing
// ---------------------------------------------------------------------------

describe("parseSriHash", () => {
  it("parses sha256 SRI string", () => {
    const result = parseSriHash("sha256-abc123def456=");
    expect(result).toEqual({ algorithm: "sha256", digest: "abc123def456=" });
  });

  it("parses sha512 SRI string", () => {
    const result = parseSriHash("sha512-longbase64string+/==");
    expect(result).toEqual({ algorithm: "sha512", digest: "longbase64string+/==" });
  });

  it("parses sha384 SRI string", () => {
    const result = parseSriHash("sha384-mediumhash");
    expect(result).toEqual({ algorithm: "sha384", digest: "mediumhash" });
  });

  it("returns null for plain hex string (not SRI)", () => {
    expect(parseSriHash("abcdef0123456789")).toBeNull();
  });

  it("returns null for unsupported algorithm", () => {
    expect(parseSriHash("md5-abc123")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSriHash("")).toBeNull();
  });

  it("returns null for malformed SRI (no dash)", () => {
    expect(parseSriHash("sha256abc123")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SRI-based tarball integrity verification
// ---------------------------------------------------------------------------

describe("verifyTarballIntegrity — SRI format", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("verifies SHA-512 SRI hash successfully", () => {
    const content = Buffer.from("test tarball for sha512");
    const crypto = require("node:crypto");
    const digest = crypto.createHash("sha512").update(content).digest("base64");
    const sriHash = `sha512-${digest}`;

    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", sriHash);
    expect(result.valid).toBe(true);
    expect(result.actualHash).toBe(sriHash);
  });

  it("verifies SHA-256 SRI hash successfully", () => {
    const content = Buffer.from("test tarball for sha256 sri");
    const crypto = require("node:crypto");
    const digest = crypto.createHash("sha256").update(content).digest("base64");
    const sriHash = `sha256-${digest}`;

    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", sriHash);
    expect(result.valid).toBe(true);
    expect(result.actualHash).toBe(sriHash);
  });

  it("rejects mismatched SHA-512 SRI hash", () => {
    const content = Buffer.from("actual content");
    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", "sha512-WRONGHASH==");
    expect(result.valid).toBe(false);
    expect(result.actualHash).toMatch(/^sha512-/);
  });

  it("still supports legacy hex SHA-256 format", () => {
    const content = Buffer.from("legacy tarball");
    const crypto = require("node:crypto");
    const hexHash = crypto.createHash("sha256").update(content).digest("hex");

    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", hexHash);
    expect(result.valid).toBe(true);
    expect(result.actualHash).toBe(hexHash);
  });

  it("rejects mismatched legacy hex hash", () => {
    const content = Buffer.from("different content");
    mockReadFileSync.mockReturnValueOnce(content);

    const result = verifyTarballIntegrity("/tmp/test.tgz", "0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate — npm dist.integrity parsing
// ---------------------------------------------------------------------------

describe("checkForUpdate — npm dist.integrity", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("extracts integrityHash from npm dist.integrity field", async () => {
    const sriHash = "sha512-abc123def456==";
    mockFetch.mockResolvedValueOnce(jsonResponse({
      version: "1.2.0",
      dist: {
        integrity: sriHash,
        shasum: "deadbeef",
        tarball: "https://registry.npmjs.org/podwatch/-/podwatch-1.2.0.tgz",
      },
    }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result?.available).toBe(true);
    expect(result?.integrityHash).toBe(sriHash);
    expect(result?.tarballUrl).toBe("https://registry.npmjs.org/podwatch/-/podwatch-1.2.0.tgz");
  });

  it("returns undefined integrityHash when npm has no dist.integrity", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      version: "1.2.0",
      // No dist field at all
    }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result?.integrityHash).toBeUndefined();
  });

  it("extracts integrityHash from dashboard response", async () => {
    // npm fails
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard provides integrityHash
    mockFetch.mockResolvedValueOnce(jsonResponse({
      version: "1.2.0",
      integrityHash: "sha512-dashboardhash==",
    }));

    const result = await checkForUpdate("1.0.0", "https://podwatch.app/api");
    expect(result).toEqual({
      available: true,
      remoteVersion: "1.2.0",
      source: "dashboard",
      integrityHash: "sha512-dashboardhash==",
    });
  });
});

// ---------------------------------------------------------------------------
// Rollback mechanism
// ---------------------------------------------------------------------------

describe("rollback mechanism", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("backupDist renames dist/ to dist.backup/", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("dist")) return true;
      if (p.endsWith("dist.backup")) return false;
      return false;
    });

    const result = backupDist("/ext/podwatch");
    expect(result).toBe("/ext/podwatch/dist.backup");
    expect(mockRenameSync).toHaveBeenCalledWith(
      "/ext/podwatch/dist",
      "/ext/podwatch/dist.backup"
    );
  });

  it("backupDist returns null if no dist/ exists", () => {
    mockExistsSync.mockReturnValue(false);

    const result = backupDist("/ext/podwatch");
    expect(result).toBeNull();
  });

  it("backupDist removes stale backup before creating new one", () => {
    mockExistsSync.mockReturnValue(true);

    backupDist("/ext/podwatch");
    expect(mockRmSync).toHaveBeenCalledWith(
      "/ext/podwatch/dist.backup",
      { recursive: true, force: true }
    );
  });

  it("restoreFromBackup moves backup back to dist/", () => {
    mockExistsSync.mockReturnValue(false);

    const result = restoreFromBackup("/ext/podwatch", "/ext/podwatch/dist.backup");
    expect(result).toBe(true);
    expect(mockRenameSync).toHaveBeenCalledWith(
      "/ext/podwatch/dist.backup",
      "/ext/podwatch/dist"
    );
  });

  it("cleanupBackup removes backup dir", () => {
    mockExistsSync.mockReturnValue(true);

    cleanupBackup("/ext/podwatch/dist.backup");
    expect(mockRmSync).toHaveBeenCalledWith(
      "/ext/podwatch/dist.backup",
      { recursive: true, force: true }
    );
  });

  it("installFromTarball rolls back on extraction failure", () => {
    // dist exists
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("dist.backup")) return false;
      if (typeof p === "string" && p.endsWith("dist")) return true;
      return false;
    });

    // tar extract fails
    mockSpawnSync.mockReturnValueOnce({
      error: new Error("tar failed"),
      status: 1,
      stdout: "",
      stderr: "error extracting",
    });

    const result = installFromTarball("/tmp/test.tgz");
    expect(result.success).toBe(false);

    // Should have backed up (rename dist → dist.backup)
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining("dist"),
      expect.stringContaining("dist.backup")
    );

    // Should have attempted rollback (rename dist.backup → dist)
    // renameSync is called twice: once for backup, once for restore
    expect(mockRenameSync).toHaveBeenCalledTimes(2);
  });

  it("installFromTarball leaves fresh backup in place on success (caller manages cleanup)", () => {
    // dist exists, but NO existing stale backup
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("dist.backup")) return false; // no stale backup
      if (typeof p === "string" && p.endsWith("dist")) return true;
      return false;
    });

    // tar extract succeeds
    mockSpawnSync.mockReturnValueOnce({
      error: null,
      status: 0,
      stdout: "",
      stderr: "",
    });

    const result = installFromTarball("/tmp/test.tgz");
    expect(result.success).toBe(true);

    // Fresh backup should NOT be cleaned up by installFromTarball —
    // caller (runUpdateCheck) cleans up after verifyNewDist
    // Note: backupDist removes STALE backups before creating new one,
    // but since no stale backup exists here, rmSync should not be called on dist.backup
    const backupRmCalls = mockRmSync.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("dist.backup")
    );
    expect(backupRmCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// downloadTarball — fetch-based
// ---------------------------------------------------------------------------

describe("downloadTarball (fetch-based)", () => {
  beforeEach(() => {
    resetMocks();
    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-xyz");
  });

  it("downloads tarball via fetch and writes to temp dir", async () => {
    const content = Buffer.from("tarball-bytes");
    mockFetch.mockResolvedValueOnce(binaryResponse(content));

    const result = await downloadTarball("1.2.0");
    expect(result.success).toBe(true);
    expect(result.tarballPath).toBe("/tmp/podwatch-update-xyz/podwatch-1.2.0.tgz");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/podwatch-update-xyz/podwatch-1.2.0.tgz",
      expect.any(Buffer)
    );
  });

  it("uses tarballUrl when provided", async () => {
    const content = Buffer.from("tarball-bytes");
    mockFetch.mockResolvedValueOnce(binaryResponse(content));

    await downloadTarball("1.2.0", "https://registry.npmjs.org/podwatch/-/podwatch-1.2.0.tgz");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/podwatch/-/podwatch-1.2.0.tgz",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("returns failure on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(binaryResponse(Buffer.from(""), 404));

    const result = await downloadTarball("1.2.0");
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  it("returns failure on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await downloadTarball("1.2.0");
    expect(result.success).toBe(false);
    expect(result.error).toContain("network down");
  });
});

// ---------------------------------------------------------------------------
// verifyNewDist
// ---------------------------------------------------------------------------

describe("verifyNewDist", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("returns ok:false with error when dist/index.js does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    // Should not spawn a child process
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns ok:true when child process exits 0", () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["-e", expect.stringContaining("require")],
      expect.objectContaining({ timeout: 15_000 })
    );
  });

  it("returns ok:false with error when child process exits non-zero (broken module)", () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "SyntaxError" });

    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("SyntaxError");
  });

  it("returns ok:false with timedOut when child process times out", () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValueOnce({
      error: new Error("ETIMEDOUT"),
      status: null,
      stdout: "",
      stderr: "",
    });

    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("returns ok:false with signal when process crashes", () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValueOnce({
      error: null,
      status: null,
      signal: "SIGSEGV",
      stdout: "",
      stderr: "",
    });

    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(false);
    expect(result.signal).toBe("SIGSEGV");
    expect(result.error).toContain("SIGSEGV");
  });

  it("returns ok:false when spawnSync itself throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockImplementationOnce(() => { throw new Error("spawn failed"); });

    const result = verifyNewDist("/ext/podwatch");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn failed");
  });
});

// ---------------------------------------------------------------------------
// waitForIdleWindow
// ---------------------------------------------------------------------------

describe("waitForIdleWindow", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true immediately when agent is idle", async () => {
    mockIsInactive.mockReturnValue(true);
    const logger = mockLogger();

    const result = await waitForIdleWindow(logger);
    expect(result).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("idle")
    );
  });

  it("defers and re-checks when agent is active, then proceeds when idle", async () => {
    // Active first call, then idle
    mockIsInactive.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const logger = mockLogger();

    const promise = waitForIdleWindow(logger);
    // Advance timer past the defer interval (5 min = 300000ms)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const result = await promise;

    expect(result).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("deferring")
    );
  });

  it("forces restart after max deferral period", async () => {
    // Always active — will hit MAX_DEFER_MS (2 hours)
    mockIsInactive.mockReturnValue(false);
    const logger = mockLogger();

    const promise = waitForIdleWindow(logger);
    // Advance timer past max deferral (2 hours = 24 x 5min intervals)
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    }
    const result = await promise;

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Forcing restart")
    );
  });
});

// ---------------------------------------------------------------------------
// triggerGatewayRestart
// ---------------------------------------------------------------------------

describe("triggerGatewayRestart", () => {
  let savedPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetMocks();
    savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (savedPlatform) {
      Object.defineProperty(process, "platform", savedPlatform);
    }
  });

  it("restarts via systemctl --user on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    // systemctl --user succeeds
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    const logger = mockLogger();
    const result = triggerGatewayRestart(logger);

    expect(result.ok).toBe(true);
    expect(result.method).toBe("systemd");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", expect.stringContaining(".service")],
      expect.any(Object)
    );
  });

  it("falls back to system-level systemctl on Linux when user-level fails", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    // user systemctl fails, system succeeds
    mockSpawnSync
      .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "failed" })
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    const logger = mockLogger();
    const result = triggerGatewayRestart(logger);

    expect(result.ok).toBe(true);
    expect(result.tried).toHaveLength(2);
  });

  it("returns ok: false when both systemctl attempts fail on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    mockSpawnSync
      .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "" });

    const logger = mockLogger();
    const result = triggerGatewayRestart(logger);

    expect(result.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not restart")
    );
  });

  it("returns unsupported for unknown platforms", () => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });

    const logger = mockLogger();
    const result = triggerGatewayRestart(logger);

    expect(result.ok).toBe(false);
    expect(result.method).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Update lock
// ---------------------------------------------------------------------------

describe("acquireUpdateLock / releaseUpdateLock", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("acquires lock when no lock file exists", () => {
    mockExistsSync.mockReturnValue(false);

    expect(acquireUpdateLock()).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".update-lock"),
      expect.stringContaining("pid")
    );
  });

  it("refuses lock when another process holds a fresh lock", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 99999, ts: Date.now() })
    );

    expect(acquireUpdateLock()).toBe(false);
    // Should NOT overwrite the lock
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("reclaims stale lock (older than 30 minutes)", () => {
    mockExistsSync.mockReturnValue(true);
    const staleTs = Date.now() - 31 * 60 * 1000;
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 99999, ts: staleTs })
    );

    expect(acquireUpdateLock()).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("reclaims corrupted lock file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");

    expect(acquireUpdateLock()).toBe(true);
  });

  it("releaseUpdateLock removes the lock file", () => {
    mockExistsSync.mockReturnValue(true);

    releaseUpdateLock();
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining(".update-lock"),
      { force: true }
    );
  });
});

// ---------------------------------------------------------------------------
// runUpdateCheck — lock integration
// ---------------------------------------------------------------------------

describe("runUpdateCheck — update lock", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("skips update when lock is held by another process", async () => {
    const logger = mockLogger();
    // shouldCheckForUpdate → true (no cache file exists for first check)
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".update-lock")) return true;
      return false; // no cache file
    });
    // Lock file is fresh (held by another process)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 99999, ts: Date.now() })
    );

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Another update is in progress")
    );
    // Should not call fetch
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runUpdateCheck — verifyNewDist rollback (backup preserved)
// ---------------------------------------------------------------------------

describe("runUpdateCheck — verifyNewDist rollback with backup", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("rolls back from backup when verifyNewDist fails after successful install", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("update with bad dist");
    const tarballDigest = crypto.createHash("sha512").update(tarballContent).digest("base64");
    const sriHash = `sha512-${tarballDigest}`;

    // npm registry fails → dashboard has hash
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.2.0", integrityHash: sriHash }));
    // downloadTarball fetches the tarball
    mockFetch.mockResolvedValueOnce(binaryResponse(tarballContent));

    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");

    // existsSync: true for dist/, dist.backup, lock file (no), cache file (no)
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".update-lock")) return false;
      if (typeof p === "string" && p.includes(".last-update-check")) return false;
      return true; // dist, dist.backup, dist/index.js all exist
    });

    // spawnSync calls:
    // 1. tar extract succeeds
    // 2. verifyNewDist → child process FAILS (bad dist)
    mockSpawnSync
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })  // tar
      .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "SyntaxError" }); // verifyNewDist fails

    // readFileSync: only verifyTarballIntegrity calls it (cache file doesn't exist per existsSync mock)
    mockReadFileSync.mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should have logged rollback
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to load")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Rolled back")
    );

    // Should have restored backup (renameSync called for backup → dist restore)
    const restoreCalls = mockRenameSync.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("dist.backup") &&
        typeof call[1] === "string" && (call[1] as string).includes("dist")
    );
    expect(restoreCalls.length).toBeGreaterThanOrEqual(1);

    // Should have sent error alert to dashboard
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "alert", severity: "error" })
    );
  });
});
