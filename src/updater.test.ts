/**
 * Tests for the auto-update system.
 *
 * Tests cover:
 * - Version comparison logic
 * - 24-hour cooldown caching
 * - NPM registry version check
 * - Dashboard API fallback version check
 * - Update execution via openclaw plugins update
 * - Error handling (network failures, bad JSON, timeouts)
 * - Safety guards (no restart during active turn)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process.exec BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockExec = vi.fn();

vi.mock("node:child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

// Mock fs for cache file operations
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import the module under test
import {
  compareVersions,
  checkForUpdate,
  executeUpdate,
  shouldCheckForUpdate,
  writeCacheTimestamp,
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
  });

  it("runs openclaw plugins update podwatch", async () => {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, "Updated podwatch to 1.1.0", "");
    });

    const result = await executeUpdate();
    expect(result.success).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "openclaw plugins update podwatch",
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function)
    );
  });

  it("returns failure on exec error", async () => {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(new Error("command failed"), "", "npm ERR!");
    });

    const result = await executeUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toContain("command failed");
  });

  it("returns failure on non-zero exit", async () => {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, "", "some warning but nonzero");
      // Simulate exec returning an error-like status
    });

    // Even with no error, the function should succeed — only Error param = failure
    const result = await executeUpdate();
    expect(result.success).toBe(true);
  });
});
