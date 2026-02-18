/**
 * Tests for lifecycle handlers — scanner 30s delay, context pressure alerts, pulse backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./transmitter.js", () => {
  const enqueuedEvents: any[] = [];
  return {
    transmitter: {
      enqueue: vi.fn((event: any) => enqueuedEvents.push(event)),
      bufferedCount: 0,
      getAgentUptimeHours: () => 0.1,
      shutdown: vi.fn().mockResolvedValue(undefined),
      _enqueuedEvents: enqueuedEvents,
      _reset() {
        enqueuedEvents.length = 0;
      },
    },
  };
});

vi.mock("./scanner.js", () => ({
  scanSkillsAndPlugins: vi.fn().mockResolvedValue({ skills: [], plugins: [] }),
}));

import { registerLifecycleHandlers } from "./hooks/lifecycle.js";
import { transmitter } from "./transmitter.js";

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

    // Advance 30s — scan should fire
    await vi.advanceTimersByTimeAsync(30_000);
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

    // Initial pulse call (from register)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance 5min — 2nd pulse (failure #2)
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Advance 5min — 3rd pulse (failure #3 — triggers backoff)
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // After 3 failures, the interval should have increased.
    // At normal 5min interval, the next pulse would fire at +5min.
    // With backoff (10min), no pulse should fire at the normal +5min mark.
    const callsBefore = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000); // +5min — should NOT fire if backed off
    // The backed-off interval is longer, so no new call at the original cadence
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("increases interval exponentially on repeated failures", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });

    // Drain initial pulse + 2 more at 5min intervals (3 consecutive failures)
    await vi.advanceTimersByTimeAsync(600_000); // +10min total → 3 calls (initial + 2)
    const callsAfter3 = fetchMock.mock.calls.length;
    expect(callsAfter3).toBe(3);

    // Now backed off to 10min. Advance 10min — should get 1 more call
    await vi.advanceTimersByTimeAsync(600_000);
    const callsAfterBackoff1 = fetchMock.mock.calls.length;
    expect(callsAfterBackoff1).toBe(callsAfter3 + 1); // failure #4

    // Now backed off to 20min. Advance 20min — should get 1 more call
    await vi.advanceTimersByTimeAsync(1_200_000);
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

    // Initial pulse (fail 1)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // +5min → fail 2, +5min → fail 3 (triggers backoff)
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Now interval is 10min. Advance 10min → success!
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // After success, interval should reset to 5min.
    // Advance 5min — should get another call at the normal cadence
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("caps backoff at 60min max", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 300_000 });

    // Drain failures to push backoff past 60min:
    // 3 failures at 5min → 10min backoff
    await vi.advanceTimersByTimeAsync(600_000); // 3 calls
    // failure 4 at 10min → 20min backoff
    await vi.advanceTimersByTimeAsync(600_000); // 4 calls
    // failure 5 at 20min → 40min backoff
    await vi.advanceTimersByTimeAsync(1_200_000); // 5 calls
    // failure 6 at 40min → 60min backoff (capped)
    await vi.advanceTimersByTimeAsync(2_400_000); // 6 calls
    const callsAtCap = fetchMock.mock.calls.length;
    expect(callsAtCap).toBe(6);

    // failure 7 should be at 60min (not 80min) — cap is 60min
    await vi.advanceTimersByTimeAsync(3_600_000); // +60min
    expect(fetchMock.mock.calls.length).toBe(callsAtCap + 1);
  });
});
