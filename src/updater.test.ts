/**
 * Tests for the auto-update system.
 *
 * Tests cover:
 * - Version comparison logic
 * - 24-hour cooldown caching
 * - NPM registry version check
 * - Dashboard API fallback version check
 * - Update execution via npm pack + extract
 * - Restart sentinel writing
 * - Service name resolution (systemd unit, launchd label)
 * - Gateway restart via systemctl (Linux)
 * - Gateway restart via launchctl (macOS)
 * - Fallback logging for unsupported platforms
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

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
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
  mockFetch.mockReset();
}

// Now import the module under test
import {
  compareVersions,
  checkForUpdate,
  executeUpdate,
  shouldCheckForUpdate,
  writeCacheTimestamp,
  writeRestartSentinel,
  triggerGatewayRestart,
  resolveStateDir,
  resolveGatewaySystemdServiceName,
  resolveGatewayLaunchAgentLabel,
  normalizeSystemdUnit,
  runUpdateCheck,
  verifyTarballIntegrity,
  AUTO_UPDATE_CACHE_FILE,
} from "./updater.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
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
      "npm",
      ["pack", "podwatch", "--pack-destination", "/tmp/podwatch-update-abc123"],
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

  it("cleans old dist directory before extracting", () => {
    // dist exists
    mockExistsSync.mockReturnValue(true);
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
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("dist"),
      { recursive: true, force: true }
    );
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

describe("service name resolution", () => {
  describe("resolveGatewaySystemdServiceName", () => {
    it("returns default name for undefined profile", () => {
      expect(resolveGatewaySystemdServiceName(undefined)).toBe("openclaw-gateway");
    });

    it("returns default name for 'default' profile", () => {
      expect(resolveGatewaySystemdServiceName("default")).toBe("openclaw-gateway");
    });

    it("returns profiled name for custom profile", () => {
      expect(resolveGatewaySystemdServiceName("myprofile")).toBe("openclaw-gateway-myprofile");
    });

    it("trims whitespace", () => {
      expect(resolveGatewaySystemdServiceName("  myprofile  ")).toBe("openclaw-gateway-myprofile");
    });
  });

  describe("resolveGatewayLaunchAgentLabel", () => {
    it("returns default label for undefined profile", () => {
      expect(resolveGatewayLaunchAgentLabel(undefined)).toBe("ai.openclaw.gateway");
    });

    it("returns default label for 'default' profile", () => {
      expect(resolveGatewayLaunchAgentLabel("default")).toBe("ai.openclaw.gateway");
    });

    it("returns profiled label for custom profile", () => {
      expect(resolveGatewayLaunchAgentLabel("myprofile")).toBe("ai.openclaw.myprofile");
    });
  });

  describe("normalizeSystemdUnit", () => {
    it("appends .service when missing", () => {
      expect(normalizeSystemdUnit("my-unit", undefined)).toBe("my-unit.service");
    });

    it("does not double-append .service", () => {
      expect(normalizeSystemdUnit("my-unit.service", undefined)).toBe("my-unit.service");
    });

    it("uses raw unit name when provided", () => {
      expect(normalizeSystemdUnit("custom-unit", undefined)).toBe("custom-unit.service");
    });

    it("falls back to default when raw is undefined", () => {
      expect(normalizeSystemdUnit(undefined, undefined)).toBe("openclaw-gateway.service");
    });

    it("falls back to profiled name when raw is empty", () => {
      expect(normalizeSystemdUnit("", "staging")).toBe("openclaw-gateway-staging.service");
    });
  });
});

describe("triggerGatewayRestart", () => {
  const originalPlatform = process.platform;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    resetMocks();
    savedEnv = {
      OPENCLAW_SYSTEMD_UNIT: process.env.OPENCLAW_SYSTEMD_UNIT,
      OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
      OPENCLAW_LAUNCHD_LABEL: process.env.OPENCLAW_LAUNCHD_LABEL,
    };
    delete process.env.OPENCLAW_SYSTEMD_UNIT;
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_LAUNCHD_LABEL;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe("Linux (systemd)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux" });
    });

    it("tries systemctl --user restart first", () => {
      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(true);
      expect(result.method).toBe("systemd");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", "openclaw-gateway.service"],
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("systemctl --user")
      );
    });

    it("falls back to system systemctl when user fails", () => {
      // User-level fails
      mockSpawnSync
        .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "failed" })
        // System-level succeeds
        .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(true);
      expect(result.method).toBe("systemd");
      expect(mockSpawnSync).toHaveBeenCalledTimes(2);
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        "systemctl",
        ["restart", "openclaw-gateway.service"],
        expect.any(Object)
      );
    });

    it("reports failure when both systemctl calls fail", () => {
      mockSpawnSync
        .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "" })
        .mockReturnValueOnce({ error: null, status: 1, stdout: "", stderr: "" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(false);
      expect(result.method).toBe("systemd");
      expect(result.tried).toHaveLength(2);
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error.mock.calls[0][0]).toContain("restart the gateway manually");
    });

    it("uses OPENCLAW_SYSTEMD_UNIT env var", () => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "my-custom-unit";
      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      triggerGatewayRestart(logger);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", "my-custom-unit.service"],
        expect.any(Object)
      );
    });

    it("uses OPENCLAW_PROFILE env var for service name", () => {
      process.env.OPENCLAW_PROFILE = "staging";
      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      triggerGatewayRestart(logger);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", "openclaw-gateway-staging.service"],
        expect.any(Object)
      );
    });

    it("handles spawnSync errors", () => {
      mockSpawnSync
        .mockReturnValueOnce({
          error: new Error("ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        })
        .mockReturnValueOnce({
          error: new Error("ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(false);
      expect(result.detail).toContain("ENOENT");
    });
  });

  describe("macOS (launchctl)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("uses launchctl kickstart -k", () => {
      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(true);
      expect(result.method).toBe("launchctl");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "launchctl",
        expect.arrayContaining(["kickstart", "-k"]),
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("launchctl")
      );
    });

    it("includes gui/<uid> in target when getuid available", () => {
      const originalGetuid = process.getuid;
      process.getuid = () => 501;

      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      triggerGatewayRestart(logger);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "launchctl",
        ["kickstart", "-k", "gui/501/ai.openclaw.gateway"],
        expect.any(Object)
      );

      process.getuid = originalGetuid;
    });

    it("uses OPENCLAW_LAUNCHD_LABEL env var", () => {
      process.env.OPENCLAW_LAUNCHD_LABEL = "com.custom.gateway";
      const originalGetuid = process.getuid;
      process.getuid = () => 501;

      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      triggerGatewayRestart(logger);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "launchctl",
        ["kickstart", "-k", "gui/501/com.custom.gateway"],
        expect.any(Object)
      );

      process.getuid = originalGetuid;
    });

    it("uses OPENCLAW_PROFILE for label resolution", () => {
      process.env.OPENCLAW_PROFILE = "staging";
      const originalGetuid = process.getuid;
      process.getuid = () => 501;

      mockSpawnSync.mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

      const logger = mockLogger();
      triggerGatewayRestart(logger);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "launchctl",
        ["kickstart", "-k", "gui/501/ai.openclaw.staging"],
        expect.any(Object)
      );

      process.getuid = originalGetuid;
    });

    it("reports failure when launchctl fails", () => {
      mockSpawnSync.mockReturnValueOnce({
        error: new Error("launchctl not found"),
        status: null,
        stdout: "",
        stderr: "",
      });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(false);
      expect(result.method).toBe("launchctl");
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error.mock.calls[0][0]).toContain("restart the gateway manually");
    });
  });

  describe("unsupported platform", () => {
    it("returns failure for Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(false);
      expect(result.method).toBe("unsupported");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported platform")
      );
    });

    it("returns failure for FreeBSD", () => {
      Object.defineProperty(process, "platform", { value: "freebsd" });

      const logger = mockLogger();
      const result = triggerGatewayRestart(logger);

      expect(result.ok).toBe(false);
      expect(result.method).toBe("unsupported");
    });
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
  const originalPlatform = process.platform;

  beforeEach(() => {
    resetMocks();
    // Make shouldCheckForUpdate() return true (no cache file)
    mockExistsSync.mockReturnValue(false);
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("verifies tarball hash against server-provided sha256", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("fake tarball");
    const tarballHash = crypto.createHash("sha256").update(tarballContent).digest("hex");

    // npm registry fails → fallback to dashboard
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard returns version + sha256
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0", sha256: tarballHash }));

    // npm pack succeeds
    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");
    mockSpawnSync
      .mockReturnValueOnce({
        error: null, status: 0,
        stdout: "podwatch-1.1.0.tgz\n", stderr: "",
      })
      // tar extract succeeds
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })
      // systemctl restart
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    // Mock reading tarball for hash verification
    mockReadFileSync.mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should have logged the hash
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(tarballHash)
    );
  });

  it("aborts update when tarball hash does NOT match server hash", async () => {
    const logger = mockLogger();

    // npm registry fails → fallback to dashboard
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    // dashboard returns version + sha256
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0", sha256: "expected_hash_abc" }));

    // npm pack succeeds
    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");
    mockSpawnSync.mockReturnValueOnce({
      error: null, status: 0,
      stdout: "podwatch-1.1.0.tgz\n", stderr: "",
    });

    // Mock reading tarball — content won't match "expected_hash_abc"
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

  it("skips update with warning when server provides no sha256", async () => {
    const logger = mockLogger();

    // npm registry returns update (no sha256 from npm)
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0" }));

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should log warning about missing hash
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No integrity hash")
    );
    // Should NOT have called npm pack (update skipped)
    const npmPackCalls = mockSpawnSync.mock.calls.filter(
      (call: unknown[]) => call[0] === "npm"
    );
    expect(npmPackCalls).toHaveLength(0);
  });

  it("logs the downloaded package hash on successful update", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("real tarball bytes");
    const tarballHash = crypto.createHash("sha256").update(tarballContent).digest("hex");

    // npm registry fails → dashboard has hash
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "1.1.0", sha256: tarballHash }));

    // npm pack succeeds
    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");
    mockSpawnSync
      .mockReturnValueOnce({
        error: null, status: 0,
        stdout: "podwatch-1.1.0.tgz\n", stderr: "",
      })
      // tar extract succeeds
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })
      // systemctl restart
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    // Mock reading tarball for hash verification
    mockReadFileSync.mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should log the hash for audit trail
    const hashLogCalls = logger.info.mock.calls.filter(
      (call: string[]) => call[0].includes("sha256:")
    );
    expect(hashLogCalls.length).toBeGreaterThan(0);
    expect(hashLogCalls[0][0]).toContain(tarballHash);
  });

  it("logs clearly what version is being installed", async () => {
    const logger = mockLogger();
    const crypto = require("node:crypto");
    const tarballContent = Buffer.from("notification test");
    const tarballHash = crypto.createHash("sha256").update(tarballContent).digest("hex");

    // npm registry fails → dashboard has hash
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: "2.0.0", sha256: tarballHash }));

    mockMkdtempSync.mockReturnValue("/tmp/podwatch-update-abc");
    mockSpawnSync
      .mockReturnValueOnce({
        error: null, status: 0,
        stdout: "podwatch-2.0.0.tgz\n", stderr: "",
      })
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ error: null, status: 0, stdout: "", stderr: "" });

    mockReadFileSync.mockReturnValueOnce(tarballContent);

    await runUpdateCheck("1.0.0", "https://podwatch.app/api", logger, { autoUpdate: true });

    // Should clearly log what's being installed
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("v1.0.0 → v2.0.0")
    );
  });
});
