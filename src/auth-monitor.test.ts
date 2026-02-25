/**
 * Tests for auth-monitor — auth profile health computation and change detection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// No transmitter mock needed — auth-monitor sends directly to API
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
globalThis.fetch = fetchMock as any;

import {
  computeProfileHealth,
  computeAllProfileHealth,
  checkAuthHealth,
  resetAuthSnapshot,
  findAuthProfilesPath,
  readAuthProfiles,
  startAuthMonitor,
  stopAuthMonitor,
  type AuthProfileHealth,
} from "./hooks/auth-monitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // Fixed timestamp for tests

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    type: "token",
    provider: "anthropic",
    ...overrides,
  };
}

function makeUsageStats(overrides: Record<string, unknown> = {}) {
  return {
    lastUsed: NOW - 60_000,
    errorCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeProfileHealth
// ---------------------------------------------------------------------------

describe("computeProfileHealth", () => {
  it("returns healthy for a simple api_key profile", () => {
    const result = computeProfileHealth(
      "google:default",
      { type: "api_key", provider: "google" },
      undefined,
      NOW,
    );
    expect(result).toEqual({
      id: "google:default",
      provider: "google",
      authType: "api_key",
      status: "healthy",
    });
  });

  it("returns healthy for a token profile with no expiry", () => {
    const result = computeProfileHealth(
      "anthropic:default",
      makeProfile(),
      undefined,
      NOW,
    );
    expect(result.status).toBe("healthy");
    expect(result.authType).toBe("token");
  });

  it("returns expiring_soon when oauth expires within 24h", () => {
    const expiresIn12h = NOW + 12 * 60 * 60 * 1_000;
    const result = computeProfileHealth(
      "google:default",
      { type: "oauth", provider: "google", expires: expiresIn12h },
      undefined,
      NOW,
    );
    expect(result.status).toBe("expiring_soon");
    expect(result.expiresAt).toBe(new Date(expiresIn12h).toISOString());
  });

  it("returns healthy when oauth expires in more than 24h", () => {
    const expiresIn48h = NOW + 48 * 60 * 60 * 1_000;
    const result = computeProfileHealth(
      "google:default",
      { type: "oauth", provider: "google", expires: expiresIn48h },
      undefined,
      NOW,
    );
    expect(result.status).toBe("healthy");
    expect(result.expiresAt).toBe(new Date(expiresIn48h).toISOString());
  });

  it("returns expired when oauth is past expiry", () => {
    const expiredAt = NOW - 60_000;
    const result = computeProfileHealth(
      "google:default",
      { type: "oauth", provider: "google", expires: expiredAt },
      undefined,
      NOW,
    );
    expect(result.status).toBe("expired");
  });

  it("returns cooldown when usageStats has active cooldown", () => {
    const cooldownUntil = NOW + 120_000;
    const result = computeProfileHealth(
      "minimax:default",
      makeProfile({ provider: "minimax" }),
      makeUsageStats({ cooldownUntil }),
      NOW,
    );
    expect(result.status).toBe("cooldown");
    expect(result.cooldownUntil).toBe(new Date(cooldownUntil).toISOString());
  });

  it("returns healthy when cooldown is in the past", () => {
    const cooldownUntil = NOW - 60_000;
    const result = computeProfileHealth(
      "minimax:default",
      makeProfile({ provider: "minimax" }),
      makeUsageStats({ cooldownUntil }),
      NOW,
    );
    expect(result.status).toBe("healthy");
  });

  it("returns disabled when disabledUntil is in the future", () => {
    const disabledUntil = NOW + 3_600_000;
    const result = computeProfileHealth(
      "openai:default",
      makeProfile({ provider: "openai", disabledUntil, disabledReason: "rate_limited" }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("disabled");
    expect(result.disabledUntil).toBe(new Date(disabledUntil).toISOString());
    expect(result.disabledReason).toBe("rate_limited");
  });

  it("disabled takes priority over cooldown", () => {
    const disabledUntil = NOW + 3_600_000;
    const cooldownUntil = NOW + 120_000;
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ disabledUntil }),
      makeUsageStats({ cooldownUntil }),
      NOW,
    );
    expect(result.status).toBe("disabled");
  });

  it("disabled takes priority over expiring_soon", () => {
    const disabledUntil = NOW + 3_600_000;
    const expiresAt = NOW + 12 * 60 * 60 * 1_000;
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ disabledUntil, expires: expiresAt }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("disabled");
  });

  it("includes errorCount from usageStats when > 0", () => {
    const result = computeProfileHealth(
      "test:default",
      makeProfile(),
      makeUsageStats({ errorCount: 5 }),
      NOW,
    );
    expect(result.errorCount).toBe(5);
  });

  it("omits errorCount when 0", () => {
    const result = computeProfileHealth(
      "test:default",
      makeProfile(),
      makeUsageStats({ errorCount: 0 }),
      NOW,
    );
    expect(result.errorCount).toBeUndefined();
  });

  it("extracts provider from id when not in profile", () => {
    const result = computeProfileHealth(
      "anthropic:default",
      { type: "token" },
      undefined,
      NOW,
    );
    expect(result.provider).toBe("anthropic");
  });

  it("handles usageStats disabledUntil", () => {
    const disabledUntil = NOW + 3_600_000;
    const result = computeProfileHealth(
      "test:default",
      makeProfile(),
      makeUsageStats({ disabledUntil, disabledReason: "api_error" }),
      NOW,
    );
    expect(result.status).toBe("disabled");
    expect(result.disabledReason).toBe("api_error");
  });

  it("handles ISO string timestamps for expires", () => {
    const expiresAt = new Date(NOW + 6 * 60 * 60 * 1_000).toISOString();
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ type: "oauth", expires: expiresAt }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("expiring_soon");
  });

  it("handles expiresAt field (alternative naming)", () => {
    const expiresAt = NOW - 1_000;
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ type: "oauth", expiresAt }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("expired");
  });

  it("returns exactly at expiry boundary as expired", () => {
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ type: "oauth", expires: NOW }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("expired");
  });

  it("returns expiring_soon at exactly 24h boundary", () => {
    const expiresExact24h = NOW + 24 * 60 * 60 * 1_000;
    const result = computeProfileHealth(
      "test:default",
      makeProfile({ type: "oauth", expires: expiresExact24h }),
      undefined,
      NOW,
    );
    expect(result.status).toBe("expiring_soon");
  });
});

// ---------------------------------------------------------------------------
// computeAllProfileHealth
// ---------------------------------------------------------------------------

describe("computeAllProfileHealth", () => {
  it("processes all profiles from a file structure", () => {
    const data = {
      version: 1,
      profiles: {
        "anthropic:default": { type: "token", provider: "anthropic" },
        "google:default": { type: "api_key", provider: "google" },
      },
      usageStats: {
        "anthropic:default": { lastUsed: NOW - 1000, errorCount: 0 },
      },
    };
    const results = computeAllProfileHealth(data, NOW);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("anthropic:default");
    expect(results[1]!.id).toBe("google:default");
  });

  it("returns empty array when no profiles", () => {
    expect(computeAllProfileHealth({}, NOW)).toEqual([]);
    expect(computeAllProfileHealth({ profiles: {} }, NOW)).toEqual([]);
  });

  it("skips null/non-object profile entries", () => {
    const data = {
      profiles: {
        "valid:default": { type: "token", provider: "valid" },
        "invalid:default": null as any,
      },
    };
    const results = computeAllProfileHealth(data, NOW);
    expect(results).toHaveLength(1);
  });

  it("correctly maps usageStats to profiles", () => {
    const cooldownUntil = NOW + 120_000;
    const data = {
      profiles: {
        "a:default": { type: "token", provider: "a" },
        "b:default": { type: "token", provider: "b" },
      },
      usageStats: {
        "a:default": { cooldownUntil, errorCount: 3 },
      },
    };
    const results = computeAllProfileHealth(data, NOW);
    const a = results.find((r) => r.id === "a:default");
    const b = results.find((r) => r.id === "b:default");
    expect(a!.status).toBe("cooldown");
    expect(a!.errorCount).toBe(3);
    expect(b!.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// checkAuthHealth — integration with transmitter
// ---------------------------------------------------------------------------

describe("checkAuthHealth", () => {
  const tmpDir = path.join(os.tmpdir(), `podwatch-auth-test-${Date.now()}`);
  const profilesDir1 = path.join(tmpDir, "credentials");
  const profilesDir2 = path.join(tmpDir, "agents", "main", "agent");

  beforeEach(() => {
    fetchMock.mockClear();
    resetAuthSnapshot();
    // Create test directories
    fs.mkdirSync(profilesDir1, { recursive: true });
    fs.mkdirSync(profilesDir2, { recursive: true });
    // Configure API endpoint for sending (startAuthMonitor does this normally)
    startAuthMonitor(999_999_999, tmpDir, "https://test.podwatch.app/api", "test-key");
    fetchMock.mockClear(); // Clear the initial check from startAuthMonitor
    resetAuthSnapshot(); // Reset snapshot so next checkAuthHealth is "first"
  });

  afterEach(() => {
    stopAuthMonitor();
    resetAuthSnapshot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProfiles(dir: string, data: object) {
    fs.writeFileSync(path.join(dir, "auth-profiles.json"), JSON.stringify(data));
  }

  it("reads from credentials/ path", () => {
    writeProfiles(profilesDir1, {
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    const result = checkAuthHealth(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("healthy");
  });

  it("falls back to agents/main/agent/ path", () => {
    writeProfiles(profilesDir2, {
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    const result = checkAuthHealth(tmpDir);
    expect(result).toHaveLength(1);
  });

  it("sends auth_health to API on first check", () => {
    writeProfiles(profilesDir1, {
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    checkAuthHealth(tmpDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://test.podwatch.app/api/auth-health");
    const body = JSON.parse(opts.body as string);
    expect(body.type).toBe("auth_health");
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].id).toBe("test:default");
    expect(body.profiles[0].status).toBe("healthy");
  });

  it("does NOT re-send when nothing changed", () => {
    writeProfiles(profilesDir1, {
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    checkAuthHealth(tmpDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    checkAuthHealth(tmpDir);
    expect(fetchMock).toHaveBeenCalledTimes(1); // No duplicate
  });

  it("re-sends when profile health changes", () => {
    const data: any = {
      profiles: { "test:default": { type: "oauth", provider: "test", expires: Date.now() + 48 * 60 * 60 * 1_000 } },
    };
    writeProfiles(profilesDir1, data);
    checkAuthHealth(tmpDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Change expiry to trigger expiring_soon
    data.profiles["test:default"].expires = Date.now() + 6 * 60 * 60 * 1_000;
    writeProfiles(profilesDir1, data);
    checkAuthHealth(tmpDir);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(body.profiles[0].status).toBe("expiring_soon");
  });

  it("returns empty array when file not found", () => {
    const result = checkAuthHealth("/nonexistent/path");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty array on invalid JSON", () => {
    fs.writeFileSync(path.join(profilesDir1, "auth-profiles.json"), "not json");
    const result = checkAuthHealth(tmpDir);
    expect(result).toEqual([]);
  });

  it("includes all profile fields in API payload", () => {
    const cooldownUntil = Date.now() + 120_000;
    writeProfiles(profilesDir1, {
      profiles: { "test:default": { type: "token", provider: "test" } },
      usageStats: { "test:default": { errorCount: 3, cooldownUntil } },
    });
    checkAuthHealth(tmpDir);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const profile = body.profiles[0];
    expect(profile.id).toBe("test:default");
    expect(profile.provider).toBe("test");
    expect(profile.authType).toBe("token");
    expect(profile.status).toBe("cooldown");
    expect(profile.errorCount).toBe(3);
    expect(profile.cooldownUntil).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// findAuthProfilesPath
// ---------------------------------------------------------------------------

describe("findAuthProfilesPath", () => {
  const tmpDir = path.join(os.tmpdir(), `podwatch-auth-find-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "credentials"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "agents", "main", "agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers credentials/ path", () => {
    fs.writeFileSync(path.join(tmpDir, "credentials", "auth-profiles.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "agents", "main", "agent", "auth-profiles.json"), "{}");
    const result = findAuthProfilesPath(tmpDir);
    expect(result).toContain("credentials");
  });

  it("falls back to agents/main/agent/ path", () => {
    fs.writeFileSync(path.join(tmpDir, "agents", "main", "agent", "auth-profiles.json"), "{}");
    const result = findAuthProfilesPath(tmpDir);
    expect(result).toContain(path.join("agents", "main", "agent"));
  });

  it("returns null when no file exists", () => {
    const result = findAuthProfilesPath(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readAuthProfiles
// ---------------------------------------------------------------------------

describe("readAuthProfiles", () => {
  const tmpFile = path.join(os.tmpdir(), `auth-profiles-test-${Date.now()}.json`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("parses valid JSON file", () => {
    const data = { version: 1, profiles: { "a:b": { type: "token" } } };
    fs.writeFileSync(tmpFile, JSON.stringify(data));
    const result = readAuthProfiles(tmpFile);
    expect(result).toEqual(data);
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(tmpFile, "not json{{{");
    expect(readAuthProfiles(tmpFile)).toBeNull();
  });

  it("returns null for nonexistent file", () => {
    expect(readAuthProfiles("/nonexistent/file.json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startAuthMonitor / stopAuthMonitor
// ---------------------------------------------------------------------------

describe("startAuthMonitor / stopAuthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    resetAuthSnapshot();
  });

  afterEach(() => {
    stopAuthMonitor();
    vi.useRealTimers();
  });

  it("performs initial check on start", () => {
    const tmpDir = path.join(os.tmpdir(), `podwatch-auth-timer-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "credentials", "auth-profiles.json"),
      JSON.stringify({ profiles: { "test:default": { type: "api_key", provider: "test" } } }),
    );

    startAuthMonitor(900_000, tmpDir, "https://test.podwatch.app/api", "test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("performs periodic checks at configured interval", () => {
    const tmpDir = path.join(os.tmpdir(), `podwatch-auth-periodic-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "credentials"), { recursive: true });

    const data: any = {
      profiles: { "test:default": { type: "oauth", provider: "test", expires: Date.now() + 48 * 60 * 60 * 1_000 } },
    };
    fs.writeFileSync(path.join(tmpDir, "credentials", "auth-profiles.json"), JSON.stringify(data));

    startAuthMonitor(60_000, tmpDir, "https://test.podwatch.app/api", "test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Change the file
    data.profiles["test:default"].expires = Date.now() + 6 * 60 * 60 * 1_000;
    fs.writeFileSync(path.join(tmpDir, "credentials", "auth-profiles.json"), JSON.stringify(data));

    vi.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stopAuthMonitor stops the interval", () => {
    const tmpDir = path.join(os.tmpdir(), `podwatch-auth-stop-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "credentials", "auth-profiles.json"),
      JSON.stringify({ profiles: { "test:default": { type: "api_key", provider: "test" } } }),
    );

    startAuthMonitor(60_000, tmpDir, "https://test.podwatch.app/api", "test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stopAuthMonitor();
    vi.advanceTimersByTime(120_000);
    // Should not have fetched more
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Need os for tmpdir in tests
import * as os from "node:os";
