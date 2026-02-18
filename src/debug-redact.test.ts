/**
 * Tests for HIGH — Debug mode must NOT leak API keys in logs.
 *
 * When PODWATCH_DEBUG is set, the plugin logs config objects. These must
 * have the apiKey field redacted before logging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to capture console.log output to verify no secrets leak.
// The register function is the default export of index.ts.

describe("debug logging redaction", () => {
  const REAL_API_KEY = "pw_live_abc123secretkey";
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PODWATCH_DEBUG", "1");
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeApi(overrides?: Record<string, any>) {
    return {
      on: vi.fn(),
      registerHook: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {
        diagnostics: { enabled: true },
        agents: { defaults: { workspace: "/tmp" } },
        secretField: "should-not-appear",
        ...overrides?.config,
      },
      pluginConfig: {
        apiKey: REAL_API_KEY,
        endpoint: "https://podwatch.app/api",
        ...overrides?.pluginConfig,
      },
      runtime: { some: "data" },
      version: "1.0.1",
    };
  }

  it("does NOT include raw API key in any debug log", async () => {
    // Dynamic import so PODWATCH_DEBUG env is picked up at module load
    vi.doMock("./transmitter.js", () => ({
      transmitter: {
        start: vi.fn(),
        enqueue: vi.fn(),
        bufferedCount: 0,
        getAgentUptimeHours: () => 0,
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("./updater.js", () => ({
      scheduleUpdateCheck: vi.fn(),
    }));

    const mod = await import("./index.js");
    const register = mod.default;
    const api = makeApi();
    register(api);

    // Collect all console.log calls into one string
    const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    // The raw API key must NOT appear anywhere in logs
    expect(allLogs).not.toContain(REAL_API_KEY);
    // But "apiKey" field name should still appear (with redacted value)
    expect(allLogs).toContain("apiKey");
  });

  it("shows redacted key (***) in debug output", async () => {
    vi.doMock("./transmitter.js", () => ({
      transmitter: {
        start: vi.fn(),
        enqueue: vi.fn(),
        bufferedCount: 0,
        getAgentUptimeHours: () => 0,
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("./updater.js", () => ({
      scheduleUpdateCheck: vi.fn(),
    }));

    const mod = await import("./index.js");
    const register = mod.default;
    const api = makeApi();
    register(api);

    const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    // The redacted placeholder must appear
    expect(allLogs).toContain("***");
  });

  it("does NOT log the full api.config object", async () => {
    vi.doMock("./transmitter.js", () => ({
      transmitter: {
        start: vi.fn(),
        enqueue: vi.fn(),
        bufferedCount: 0,
        getAgentUptimeHours: () => 0,
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("./updater.js", () => ({
      scheduleUpdateCheck: vi.fn(),
    }));

    const mod = await import("./index.js");
    const register = mod.default;
    const api = makeApi();
    register(api);

    const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    // The full config should not be dumped — secretField proves it was the raw config
    expect(allLogs).not.toContain("secretField");
    expect(allLogs).not.toContain("should-not-appear");
  });

  it("does NOT log raw pluginConfig with real API key", async () => {
    vi.doMock("./transmitter.js", () => ({
      transmitter: {
        start: vi.fn(),
        enqueue: vi.fn(),
        bufferedCount: 0,
        getAgentUptimeHours: () => 0,
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("./updater.js", () => ({
      scheduleUpdateCheck: vi.fn(),
    }));

    const mod = await import("./index.js");
    const register = mod.default;
    const api = makeApi();
    register(api);

    // Find the specific pluginConfig log line
    const pluginConfigLogs = consoleSpy.mock.calls
      .filter((c) => c.some((arg: any) => typeof arg === "string" && arg.includes("pluginConfig")))
      .map((c) => c.join(" "))
      .join("\n");

    // Must not contain the raw key
    expect(pluginConfigLogs).not.toContain(REAL_API_KEY);
  });

  it("does NOT log raw pluginConfig in resolveConfig", async () => {
    vi.doMock("./transmitter.js", () => ({
      transmitter: {
        start: vi.fn(),
        enqueue: vi.fn(),
        bufferedCount: 0,
        getAgentUptimeHours: () => 0,
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("./updater.js", () => ({
      scheduleUpdateCheck: vi.fn(),
    }));

    const mod = await import("./index.js");
    const register = mod.default;
    const api = makeApi();
    register(api);

    // Find the resolveConfig log lines
    const resolveConfigLogs = consoleSpy.mock.calls
      .filter((c) => c.some((arg: any) => typeof arg === "string" && arg.includes("resolveConfig")))
      .map((c) => c.join(" "))
      .join("\n");

    // Must not contain the raw key in resolveConfig logs
    expect(resolveConfigLogs).not.toContain(REAL_API_KEY);
  });
});
