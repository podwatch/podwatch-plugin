/**
 * Tests for lifecycle handlers — scanner 30s delay, context pressure alerts, pulse backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mockTransmitter, enqueuedEvents } from "./test-helpers/mock-transmitter.js";
vi.mock("./transmitter.js", () => ({ transmitter: mockTransmitter }));

vi.mock("./scanner.js", () => ({
  scanSkillsAndPlugins: vi.fn().mockResolvedValue({ skills: [], plugins: [] }),
}));

// NOTE: Do NOT mock config-monitor — it leaks into config-monitor.test.ts
// in Bun's single-process runner. Use vi.spyOn instead.

import { registerLifecycleHandlers } from "./hooks/lifecycle.js";
import { transmitter } from "./transmitter.js";
import * as configMonitor from "./config-monitor.js";

// Spy on config-monitor functions so we can assert calls without mocking
const checkConfigChangesSpy = vi.spyOn(configMonitor, "checkConfigChanges");
const initSnapshotSpy = vi.spyOn(configMonitor, "initSnapshot");
const resetSnapshotSpy = vi.spyOn(configMonitor, "resetSnapshot");

function getEnqueued(): any[] {
  return (transmitter as any)._enqueuedEvents;
}

function resetEnqueued(): void {
  (transmitter as any)._reset();
  (transmitter.enqueue as any).mockClear();
}

function makeApi() {
  const handlers: Record<string, Function> = {};
  return {
    on: (name: string, handler: Function) => {
      handlers[name] = handler;
    },
    registerHook: (name: string, handler: Function, _opts?: any) => {
      handlers[name] = handler;
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { agents: { defaults: { workspace: "/tmp/test" } } },
    _trigger: async (name: string, event: any, ctx?: any) => {
      if (handlers[name]) await handlers[name](event, ctx);
    },
  };
}

describe("lifecycle — scanner 30s delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEnqueued();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays initial scan by 30 seconds", async () => {
    const api = makeApi();

    // Mock fetch for pulse
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    registerLifecycleHandlers(api, { apiKey: "test" });

    // Immediately after registration — no scan event yet (only possible pulse fetch)
    const scanEvents = getEnqueued().filter((e: any) => e.type === "scan");
    expect(scanEvents).toHaveLength(0);

    // Advance 30s — scan should fire (async: setTimeout fires runScan which is a promise)
    await vi.advanceTimersByTimeAsync(30_000);
    // Flush any remaining microtasks from the async scan
    await new Promise(r => process.nextTick(r));
    const scanEventsAfter = getEnqueued().filter((e: any) => e.type === "scan");
    expect(scanEventsAfter).toHaveLength(1);
  });
});

describe("lifecycle — context pressure alerts", () => {
  beforeEach(() => {
    resetEnqueued();
  });

  it("emits context_pressure alert when ratio > 0.8", async () => {
    const api = makeApi();

    // Mock fetch for pulse
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    registerLifecycleHandlers(api, { apiKey: "test" });

    await api._trigger("before_compaction", {
      messageCount: 50,
      tokenCount: 90000,
      contextLimit: 100000,
    }, { sessionKey: "s1", agentId: "main" });

    const events = getEnqueued();
    const compaction = events.find((e: any) => e.type === "compaction");
    const alert = events.find((e: any) => e.type === "alert");

    expect(compaction).toBeDefined();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("warning");
    expect(alert.pattern).toBe("context_pressure");
    expect(alert.tokenCount).toBe(90000);
    expect(alert.contextLimit).toBe(100000);
    expect(alert.ratio).toBe(0.9);
  });

  it("does NOT emit alert when ratio <= 0.8", async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    registerLifecycleHandlers(api, { apiKey: "test" });

    await api._trigger("before_compaction", {
      messageCount: 30,
      tokenCount: 70000,
      contextLimit: 100000,
    }, { sessionKey: "s1", agentId: "main" });

    const alerts = getEnqueued().filter((e: any) => e.type === "alert");
    expect(alerts).toHaveLength(0);
  });

  it("does NOT emit alert when contextLimit is missing", async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    registerLifecycleHandlers(api, { apiKey: "test" });

    await api._trigger("before_compaction", {
      messageCount: 50,
      tokenCount: 90000,
      // no contextLimit
    }, { sessionKey: "s1", agentId: "main" });

    const alerts = getEnqueued().filter((e: any) => e.type === "alert");
    expect(alerts).toHaveLength(0);
  });

  it("does NOT emit alert when tokenCount is missing", async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    registerLifecycleHandlers(api, { apiKey: "test" });

    await api._trigger("before_compaction", {
      messageCount: 50,
      // no tokenCount
      contextLimit: 100000,
    }, { sessionKey: "s1", agentId: "main" });

    const alerts = getEnqueued().filter((e: any) => e.type === "alert");
    expect(alerts).toHaveLength(0);
  });
});

describe("lifecycle — pulse backoff on failure", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /**
   * Yield to the microtask queue so async timer callbacks (sendPulseWithBackoff)
   * can complete. Bun's vi.advanceTimersByTime is synchronous — it fires the
   * timer callback, but async code inside (await fetch) suspends. One microtask
   * flush lets the promise resolve and the function finish (including scheduling
   * the next setTimeout).
   */
  const tick = () => Promise.resolve();

  beforeEach(() => {
    vi.useFakeTimers();
    resetEnqueued();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off after 3 consecutive pulse failures", async () => {
    // Pulse fails every time
    fetchMock.mockRejectedValue(new Error("network error"));

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });
    await tick(); // let initial pulse complete & schedule next timeout

    // Initial pulse call (from register)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance 5min — 2nd pulse (failure #2)
    vi.advanceTimersByTime(300_000);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Advance 5min — 3rd pulse (failure #3 — triggers backoff)
    vi.advanceTimersByTime(300_000);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // After 3 failures, the interval should have increased.
    // At normal 5min interval, the next pulse would fire at +5min.
    // With backoff (10min), no pulse should fire at the normal +5min mark.
    const callsBefore = fetchMock.mock.calls.length;
    vi.advanceTimersByTime(300_000); // +5min — should NOT fire if backed off
    await tick();
    // The backed-off interval is longer, so no new call at the original cadence
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("increases interval exponentially on repeated failures", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });
    await tick(); // initial pulse (1), fc=1

    // 2nd pulse at +5min
    vi.advanceTimersByTime(300_000);
    await tick(); // fc=2

    // 3rd pulse at +5min (triggers backoff → next interval 10min)
    vi.advanceTimersByTime(300_000);
    await tick(); // fc=3

    const callsAfter3 = fetchMock.mock.calls.length;
    expect(callsAfter3).toBe(3);

    // Now backed off to 10min. Advance 10min — should get 1 more call
    vi.advanceTimersByTime(600_000);
    await tick();
    const callsAfterBackoff1 = fetchMock.mock.calls.length;
    expect(callsAfterBackoff1).toBe(callsAfter3 + 1); // failure #4

    // Now backed off to 20min. Advance 20min — should get 1 more call
    vi.advanceTimersByTime(1_200_000);
    await tick();
    const callsAfterBackoff2 = fetchMock.mock.calls.length;
    expect(callsAfterBackoff2).toBe(callsAfterBackoff1 + 1); // failure #5
  });

  it("resets interval to normal after successful pulse", async () => {
    // First 3 calls fail, then succeed
    fetchMock
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("fail 3"))
      .mockResolvedValueOnce({ ok: true, status: 200 }) // success!
      .mockResolvedValue({ ok: true, status: 200 }); // future successes

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });
    await tick(); // initial pulse (fail 1)

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // +5min → fail 2
    vi.advanceTimersByTime(300_000);
    await tick();
    // +5min → fail 3 (triggers backoff)
    vi.advanceTimersByTime(300_000);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Now interval is 10min. Advance 10min → success!
    vi.advanceTimersByTime(600_000);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // After success, interval should reset to 5min.
    // Advance 5min — should get another call at the normal cadence
    vi.advanceTimersByTime(300_000);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("caps backoff at 60min max", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });
    await tick(); // initial pulse (1), fc=1

    // 3 failures at 5min → 10min backoff
    vi.advanceTimersByTime(300_000); await tick(); // (2) fc=2
    vi.advanceTimersByTime(300_000); await tick(); // (3) fc=3, next=10min
    // failure 4 at 10min → 20min backoff
    vi.advanceTimersByTime(600_000); await tick(); // (4) fc=4, next=20min
    // failure 5 at 20min → 40min backoff
    vi.advanceTimersByTime(1_200_000); await tick(); // (5) fc=5, next=40min
    // failure 6 at 40min → 60min backoff (capped)
    vi.advanceTimersByTime(2_400_000); await tick(); // (6) fc=6, next=60min
    const callsAtCap = fetchMock.mock.calls.length;
    expect(callsAtCap).toBe(6);

    // failure 7 should be at 60min (not 80min) — cap is 60min
    vi.advanceTimersByTime(3_600_000);
    await tick();
    expect(fetchMock.mock.calls.length).toBe(callsAtCap + 1);
  });
});

describe("lifecycle — config monitor integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEnqueued();
    initSnapshotSpy.mockClear();
    checkConfigChangesSpy.mockClear();
    resetSnapshotSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes config snapshot on register", () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    registerLifecycleHandlers(api, { apiKey: "test" });

    expect(resetSnapshotSpy).toHaveBeenCalled();
    expect(initSnapshotSpy).toHaveBeenCalledWith(api.config);
  });

  it("checks config changes on each pulse", async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });

    // Initial pulse call checks config
    expect(checkConfigChangesSpy).toHaveBeenCalledWith(api.config);

    checkConfigChangesSpy.mockClear();

    // Let initial pulse complete so next setTimeout is set
    await Promise.resolve();

    // Advance to next pulse
    vi.advanceTimersByTime(300_000);
    // checkConfigChanges is called synchronously at the start of sendPulseWithBackoff
    expect(checkConfigChangesSpy).toHaveBeenCalledWith(api.config);
  });

  it("checks config changes on gateway_start", async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    registerLifecycleHandlers(api, { apiKey: "test" });
    checkConfigChangesSpy.mockClear();

    // Trigger gateway_start
    await api._trigger("gateway_start", { port: 3000 });

    expect(checkConfigChangesSpy).toHaveBeenCalledWith(api.config);
  });
});
