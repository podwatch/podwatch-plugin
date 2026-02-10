/**
 * Tests for lifecycle handlers — scanner 30s delay, context pressure alerts.
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
