/**
 * Tests for HIGH — Debug mode must NOT leak API keys in logs.
 *
 * When PODWATCH_DEBUG is set, the plugin logs config objects. These must
 * have the apiKey field redacted before logging.
 *
 * Bun-compatible: uses vi.mock (hoisted), manual env management,
 * and a single register() call shared across assertions.
 *
 * IMPORTANT: We only mock leaf dependencies (transmitter, updater, scanner,
 * config-monitor) — NOT the hooks modules themselves. Mocking hooks causes
 * cross-file mock leaks in Bun (which runs all tests in one process).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mock leaf dependencies to prevent side effects
// ---------------------------------------------------------------------------

import { mockTransmitter } from "./test-helpers/mock-transmitter.js";
vi.mock("./transmitter.js", () => ({ transmitter: mockTransmitter }));

vi.mock("./updater.js", () => ({
  scheduleUpdateCheck: vi.fn(),
}));

vi.mock("./scanner.js", () => ({
  scanSkillsAndPlugins: vi.fn().mockResolvedValue({ skills: [], plugins: [] }),
}));

vi.mock("./config-monitor.js", () => ({
  initSnapshot: vi.fn(),
  checkConfigChanges: vi.fn().mockReturnValue([]),
  resetSnapshot: vi.fn(),
}));

import register from "./index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("debug logging redaction", () => {
  const REAL_API_KEY = "pw_live_abc123secretkey";
  let allLogs: string;
  let pluginConfigLogs: string;
  let resolveConfigLogs: string;

  beforeAll(() => {
    // Enable debug mode (isDebug() checks env at runtime)
    process.env.PODWATCH_DEBUG = "1";

    // Mock fetch to prevent real pulse HTTP calls from lifecycle hooks
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const api = {
      on: vi.fn(),
      registerHook: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {
        diagnostics: { enabled: true },
        agents: { defaults: { workspace: "/tmp" } },
        secretField: "should-not-appear",
      },
      pluginConfig: {
        apiKey: REAL_API_KEY,
        endpoint: "https://podwatch.app/api",
      },
      runtime: { some: "data" },
      version: "1.0.1",
    };

    register(api);

    // Capture all logs for assertions
    allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    pluginConfigLogs = consoleSpy.mock.calls
      .filter((c) => c.some((arg: any) => typeof arg === "string" && arg.includes("pluginConfig")))
      .map((c) => c.join(" "))
      .join("\n");

    resolveConfigLogs = consoleSpy.mock.calls
      .filter((c) => c.some((arg: any) => typeof arg === "string" && arg.includes("resolveConfig")))
      .map((c) => c.join(" "))
      .join("\n");
  });

  afterAll(() => {
    delete process.env.PODWATCH_DEBUG;
    vi.restoreAllMocks();
  });

  it("does NOT include raw API key in any debug log", () => {
    // The raw API key must NOT appear anywhere in logs
    expect(allLogs).not.toContain(REAL_API_KEY);
    // But "apiKey" field name should still appear (with redacted value)
    expect(allLogs).toContain("apiKey");
  });

  it("shows redacted key (***) in debug output", () => {
    // The redacted placeholder must appear
    expect(allLogs).toContain("***");
  });

  it("does NOT log the full api.config object", () => {
    // The full config should not be dumped — secretField proves it was the raw config
    expect(allLogs).not.toContain("secretField");
    expect(allLogs).not.toContain("should-not-appear");
  });

  it("does NOT log raw pluginConfig with real API key", () => {
    // Must not contain the raw key
    expect(pluginConfigLogs).not.toContain(REAL_API_KEY);
  });

  it("does NOT log raw pluginConfig in resolveConfig", () => {
    // Must not contain the raw key in resolveConfig logs
    expect(resolveConfigLogs).not.toContain(REAL_API_KEY);
  });
});
