/**
 * Tests for config-doctor — config health audit and score computation.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock fetch for API calls
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
globalThis.fetch = fetchMock as any;

import {
  checkChannelHealth,
  checkPluginHealth,
  checkSkillsHealth,
  checkSessionLocks,
  checkSecurityConfig,
  checkMemoryReadiness,
  checkHeartbeatConfig,
  checkConfigWarnings,
  computeHealthScore,
  runAllChecks,
  checkConfigHealth,
  readOpenClawConfig,
  resetConfigDoctorState,
  startConfigDoctor,
  stopConfigDoctor,
  type HealthCheck,
  type CheckStatus,
} from "./config-doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channels: {
      telegram: { enabled: true },
    },
    plugins: {
      podwatch: { enabled: true },
    },
    agents: {
      defaults: {
        toolPolicy: { exec: "allow" },
      },
    },
    heartbeat: {
      enabled: true,
      intervalMs: 300_000,
    },
    memory: {
      embedding: { model: "text-embedding-3-small" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. checkChannelHealth
// ---------------------------------------------------------------------------

describe("checkChannelHealth", () => {
  it("returns warn when no channels configured", () => {
    const result = checkChannelHealth({});
    expect(result.check).toBe("channels");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("No channels");
  });

  it("returns warn when channels object is empty", () => {
    const result = checkChannelHealth({ channels: {} });
    expect(result.status).toBe("warn");
  });

  it("returns pass for healthy channels", () => {
    const result = checkChannelHealth({
      channels: { telegram: { enabled: true }, discord: { enabled: true } },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2 channel");
  });

  it("returns pass with disabled count when some channels disabled", () => {
    const result = checkChannelHealth({
      channels: { telegram: { enabled: true }, discord: { enabled: false } },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 disabled");
  });

  it("returns warn when all channels disabled", () => {
    const result = checkChannelHealth({
      channels: { telegram: { enabled: false }, discord: { enabled: false } },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("All channels are disabled");
  });

  it("returns fail when channels have errors", () => {
    const result = checkChannelHealth({
      channels: {
        telegram: { enabled: true, error: "Auth failed" },
      },
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("error");
  });

  it("detects lastError field as error condition", () => {
    const result = checkChannelHealth({
      channels: {
        telegram: { enabled: true, lastError: "Connection refused" },
      },
    });
    expect(result.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// 2. checkPluginHealth
// ---------------------------------------------------------------------------

describe("checkPluginHealth", () => {
  it("returns pass when no plugins configured", () => {
    const result = checkPluginHealth({});
    expect(result.status).toBe("pass");
    expect(result.message).toContain("No plugins");
  });

  it("returns pass for healthy plugins", () => {
    const result = checkPluginHealth({
      plugins: { podwatch: { enabled: true }, analytics: { enabled: true } },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2 plugin");
  });

  it("returns warn when some plugins disabled", () => {
    const result = checkPluginHealth({
      plugins: { podwatch: { enabled: true }, analytics: { enabled: false } },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("1 disabled");
  });

  it("returns fail when plugins have errors", () => {
    const result = checkPluginHealth({
      plugins: { broken: { error: "Module not found" } },
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("broken");
  });

  it("detects loadError as error condition", () => {
    const result = checkPluginHealth({
      plugins: { broken: { loadError: "Cannot resolve" } },
    });
    expect(result.status).toBe("fail");
  });

  it("returns pass for empty plugins object", () => {
    const result = checkPluginHealth({ plugins: {} });
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 3. checkSkillsHealth
// ---------------------------------------------------------------------------

describe("checkSkillsHealth", () => {
  it("returns pass when no skills", () => {
    const result = checkSkillsHealth({});
    expect(result.status).toBe("pass");
  });

  it("returns pass for healthy skills array", () => {
    const result = checkSkillsHealth({
      skills: [
        { name: "web-search", eligible: true },
        { name: "code-review", eligible: true },
      ],
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2 skill");
  });

  it("returns warn for skills with missing requirements", () => {
    const result = checkSkillsHealth({
      skills: [
        { name: "web-search", eligible: true },
        { name: "code-review", eligible: false, missingRequirements: ["node >= 20"] },
      ],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("1 with missing");
  });

  it("handles skills as object", () => {
    const result = checkSkillsHealth({
      skills: {
        "web-search": { eligible: true },
        "deploy": { eligible: false },
      },
    });
    expect(result.status).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// 4. checkSessionLocks
// ---------------------------------------------------------------------------

describe("checkSessionLocks", () => {
  const tmpDir = path.join(os.tmpdir(), `config-doctor-test-${Date.now()}`);
  const locksDir = path.join(tmpDir, "locks");

  beforeEach(() => {
    fs.mkdirSync(locksDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pass when no lock directories exist", () => {
    const result = checkSessionLocks("/nonexistent/path", NOW);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("No lock files");
  });

  it("returns pass for recent lock files", () => {
    const lockFile = path.join(locksDir, "session.lock");
    fs.writeFileSync(lockFile, "123");
    const result = checkSessionLocks(tmpDir, NOW);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("active lock");
  });

  it("returns warn for stale lock files", () => {
    const lockFile = path.join(locksDir, "old-session.lock");
    fs.writeFileSync(lockFile, "456");
    // Set mtime to 3 hours ago
    const threeHoursAgo = new Date(NOW - 3 * 60 * 60 * 1_000);
    fs.utimesSync(lockFile, threeHoursAgo, threeHoursAgo);
    const result = checkSessionLocks(tmpDir, NOW);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("stale");
    expect(result.detail).toContain("old-session.lock");
  });

  it("detects .pid files as lock files", () => {
    const pidFile = path.join(locksDir, "gateway.pid");
    fs.writeFileSync(pidFile, "999");
    const threeHoursAgo = new Date(NOW - 3 * 60 * 60 * 1_000);
    fs.utimesSync(pidFile, threeHoursAgo, threeHoursAgo);
    const result = checkSessionLocks(tmpDir, NOW);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("gateway.pid");
  });
});

// ---------------------------------------------------------------------------
// 5. checkSecurityConfig
// ---------------------------------------------------------------------------

describe("checkSecurityConfig", () => {
  it("returns warn when no tool policy", () => {
    const result = checkSecurityConfig({
      agents: { defaults: {} },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("tool policy");
  });

  it("returns pass with valid security config", () => {
    const result = checkSecurityConfig({
      agents: { defaults: { toolPolicy: { exec: "allow" } } },
    });
    expect(result.status).toBe("pass");
  });

  it("handles sandbox as string", () => {
    // sandbox = "off" should pass if tool policy exists
    const result = checkSecurityConfig({
      agents: { defaults: { sandbox: "off", toolPolicy: { exec: "allow" } } },
    });
    expect(result.status).toBe("pass");
  });

  it("handles sandbox as object with mode", () => {
    // sandbox mode "off" should pass
    const result = checkSecurityConfig({
      agents: { defaults: { sandbox: { mode: "off" }, toolPolicy: { exec: "allow" } } },
    });
    expect(result.status).toBe("pass");
  });

  it("returns warn when no agents config at all", () => {
    const result = checkSecurityConfig({});
    expect(result.status).toBe("warn");
    expect(result.message).toContain("tool policy");
  });
});

// ---------------------------------------------------------------------------
// 6. checkMemoryReadiness
// ---------------------------------------------------------------------------

describe("checkMemoryReadiness", () => {
  it("returns warn when no memory configured", () => {
    const result = checkMemoryReadiness({});
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Memory not configured");
  });

  it("returns warn when no embedding model", () => {
    const result = checkMemoryReadiness({ memory: {} });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("No embedding model");
  });

  it("returns pass when embedding model configured", () => {
    const result = checkMemoryReadiness({
      memory: { embedding: { model: "text-embedding-3-small" } },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("text-embedding-3-small");
  });
});

// ---------------------------------------------------------------------------
// 7. checkHeartbeatConfig
// ---------------------------------------------------------------------------

describe("checkHeartbeatConfig", () => {
  it("returns warn when no heartbeat configured", () => {
    const result = checkHeartbeatConfig({});
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not configured");
  });

  it("returns warn when heartbeat disabled", () => {
    const result = checkHeartbeatConfig({ heartbeat: { enabled: false } });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("disabled");
  });

  it("returns pass for enabled heartbeat with reasonable interval", () => {
    const result = checkHeartbeatConfig({
      heartbeat: { enabled: true, intervalMs: 300_000 },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("300000ms");
  });

  it("returns warn for very low interval", () => {
    const result = checkHeartbeatConfig({
      heartbeat: { enabled: true, intervalMs: 5_000 },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("too low");
  });

  it("returns warn for very high interval", () => {
    const result = checkHeartbeatConfig({
      heartbeat: { enabled: true, intervalMs: 7_200_000 },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("very high");
  });

  it("returns pass for enabled heartbeat without interval specified", () => {
    const result = checkHeartbeatConfig({
      heartbeat: { enabled: true },
    });
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Heartbeat enabled");
  });
});

// ---------------------------------------------------------------------------
// 8. checkConfigWarnings
// ---------------------------------------------------------------------------

describe("checkConfigWarnings", () => {
  it("returns pass for known keys only", () => {
    const result = checkConfigWarnings({
      channels: {},
      plugins: {},
      agents: {},
    });
    expect(result.status).toBe("pass");
  });

  it("detects unknown keys", () => {
    const result = checkConfigWarnings({
      channels: {},
      weirdSetting: true,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("unknown");
    expect(result.detail).toContain("weirdSetting");
  });

  it("detects deprecated keys", () => {
    const result = checkConfigWarnings({
      channels: {},
      llm: { model: "gpt-4" },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("deprecated");
    expect(result.detail).toContain("models");
  });

  it("deprecated takes priority over unknown", () => {
    const result = checkConfigWarnings({
      bot: {},
      unknownKey: {},
    });
    // deprecated should come first
    expect(result.status).toBe("warn");
    expect(result.message).toContain("deprecated");
  });
});

// ---------------------------------------------------------------------------
// computeHealthScore
// ---------------------------------------------------------------------------

describe("computeHealthScore", () => {
  it("returns 100 for all pass", () => {
    const checks: HealthCheck[] = [
      { check: "a", status: "pass", message: "ok" },
      { check: "b", status: "pass", message: "ok" },
    ];
    expect(computeHealthScore(checks)).toBe(100);
  });

  it("subtracts 5 per warn", () => {
    const checks: HealthCheck[] = [
      { check: "a", status: "warn", message: "..." },
      { check: "b", status: "pass", message: "ok" },
    ];
    expect(computeHealthScore(checks)).toBe(95);
  });

  it("subtracts 20 per fail", () => {
    const checks: HealthCheck[] = [
      { check: "a", status: "fail", message: "..." },
      { check: "b", status: "pass", message: "ok" },
    ];
    expect(computeHealthScore(checks)).toBe(80);
  });

  it("handles multiple failures", () => {
    const checks: HealthCheck[] = [
      { check: "a", status: "fail", message: "..." },
      { check: "b", status: "fail", message: "..." },
      { check: "c", status: "warn", message: "..." },
    ];
    expect(computeHealthScore(checks)).toBe(55);
  });

  it("floors at 0", () => {
    const checks: HealthCheck[] = Array(10).fill(null).map((_, i) => ({
      check: `check${i}`,
      status: "fail" as CheckStatus,
      message: "bad",
    }));
    expect(computeHealthScore(checks)).toBe(0);
  });

  it("returns 100 for empty checks", () => {
    expect(computeHealthScore([])).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// runAllChecks
// ---------------------------------------------------------------------------

describe("runAllChecks", () => {
  const tmpDir = path.join(os.tmpdir(), `config-doctor-run-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns score 0 when config file missing", () => {
    const result = runAllChecks(tmpDir);
    expect(result.score).toBe(0);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe("fail");
    expect(result.checks[0]!.check).toBe("config_read");
  });

  it("runs all 8 checks when config exists", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    const result = runAllChecks(tmpDir, NOW);
    expect(result.checks).toHaveLength(8);
    expect(result.score).toBeGreaterThan(0);
    expect(result.checkedAt).toBeTruthy();
  });

  it("returns high score for healthy config", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    const result = runAllChecks(tmpDir, NOW);
    // Should have channels=pass, plugins=pass, skills=pass(no skills), locks=pass,
    // security=pass, memory=pass, heartbeat=pass, config_warnings=pass
    expect(result.score).toBe(100);
  });

  it("returns lower score for config with issues", () => {
    const config = {
      channels: {},                  // warn: no channels
      plugins: { broken: { error: "fail" } },  // fail
      llm: {},                        // deprecated key: warn
      heartbeat: { enabled: false },  // warn
    };
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    const result = runAllChecks(tmpDir, NOW);
    expect(result.score).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// checkConfigHealth — change detection + API sending
// ---------------------------------------------------------------------------

describe("checkConfigHealth", () => {
  const tmpDir = path.join(os.tmpdir(), `config-doctor-change-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    resetConfigDoctorState();
    fetchMock.mockClear();
  });

  afterEach(() => {
    stopConfigDoctor();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends on first check", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    // Configure endpoint
    startConfigDoctor(900_000, tmpDir, "https://test.api/api", "test-key");
    // startConfigDoctor calls checkConfigHealth internally
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not send when nothing changed", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    startConfigDoctor(900_000, tmpDir, "https://test.api/api", "test-key");
    fetchMock.mockClear();

    // Second check — nothing changed
    checkConfigHealth(tmpDir, NOW + 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends when score changes", () => {
    let config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    startConfigDoctor(900_000, tmpDir, "https://test.api/api", "test-key");
    fetchMock.mockClear();

    // Change config to introduce a failure
    config = makeConfig({ plugins: { broken: { error: "fail" } } });
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    checkConfigHealth(tmpDir, NOW + 60_000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("force-sends after 1 hour even if nothing changed", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    // Don't use startConfigDoctor — directly call checkConfigHealth to control timing
    resetConfigDoctorState();
    // Simulate configuring the endpoint by starting and immediately stopping
    startConfigDoctor(900_000, tmpDir, "https://test.api/api", "test-key");
    fetchMock.mockClear();

    // The initial check used Date.now() internally, so force-send threshold
    // is relative to that. Use Date.now() + 1 hour to guarantee it triggers.
    const futureTime = Date.now() + 3_600_001;
    checkConfigHealth(tmpDir, futureTime);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns result even without endpoint configured", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));

    const result = checkConfigHealth(tmpDir, NOW);
    expect(result.score).toBeGreaterThan(0);
    expect(result.checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// readOpenClawConfig
// ---------------------------------------------------------------------------

describe("readOpenClawConfig", () => {
  const tmpDir = path.join(os.tmpdir(), `config-doctor-read-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    expect(readOpenClawConfig(tmpDir)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), "not json");
    expect(readOpenClawConfig(tmpDir)).toBeNull();
  });

  it("returns parsed config", () => {
    const config = { channels: { telegram: {} } };
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));
    const result = readOpenClawConfig(tmpDir);
    expect(result).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("startConfigDoctor / stopConfigDoctor", () => {
  const tmpDir = path.join(os.tmpdir(), `config-doctor-lifecycle-${Date.now()}`);

  beforeEach(() => {
    vi.useFakeTimers();
    fs.mkdirSync(tmpDir, { recursive: true });
    resetConfigDoctorState();
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopConfigDoctor();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs initial check on start", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));
    startConfigDoctor(900_000, tmpDir, "https://test.api/api", "test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runs periodic checks", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));
    startConfigDoctor(60_000, tmpDir, "https://test.api/api", "test-key");
    fetchMock.mockClear();

    // Advance timer — but snapshot hasn't changed so no fetch
    // Need to change config to trigger a send
    const newConfig = makeConfig({ plugins: { broken: { error: "fail" } } });
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(newConfig));

    vi.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("stop prevents further checks", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(config));
    startConfigDoctor(60_000, tmpDir, "https://test.api/api", "test-key");
    fetchMock.mockClear();

    stopConfigDoctor();

    const newConfig = makeConfig({ plugins: { broken: { error: "fail" } } });
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), JSON.stringify(newConfig));

    vi.advanceTimersByTime(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Null safety — handlers must never throw
// ---------------------------------------------------------------------------

describe("null safety", () => {
  it("checkChannelHealth handles non-object channels", () => {
    expect(() => checkChannelHealth({ channels: "bad" as any })).not.toThrow();
  });

  it("checkPluginHealth handles non-object plugins", () => {
    expect(() => checkPluginHealth({ plugins: null as any })).not.toThrow();
  });

  it("checkSkillsHealth handles empty array", () => {
    expect(() => checkSkillsHealth({ skills: [] })).not.toThrow();
  });

  it("checkSecurityConfig handles deeply missing config", () => {
    expect(() => checkSecurityConfig({})).not.toThrow();
  });

  it("checkMemoryReadiness handles null memory", () => {
    expect(() => checkMemoryReadiness({ memory: null as any })).not.toThrow();
  });

  it("checkHeartbeatConfig handles non-object heartbeat", () => {
    expect(() => checkHeartbeatConfig({ heartbeat: "yes" as any })).not.toThrow();
  });

  it("checkConfigWarnings handles empty config", () => {
    expect(() => checkConfigWarnings({})).not.toThrow();
  });

  it("checkConfigHealth handles non-existent state dir", () => {
    expect(() => checkConfigHealth("/nonexistent/dir")).not.toThrow();
  });
});

// Restore original fetch
afterAll(() => {
  globalThis.fetch = originalFetch;
});
