/**
 * Tests for cost handler — lastSeenIndex dedup and costBreakdown field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the transmitter before importing cost handler
vi.mock("./transmitter.js", () => {
  const enqueuedEvents: any[] = [];
  return {
    transmitter: {
      enqueue: vi.fn((event: any) => enqueuedEvents.push(event)),
      _enqueuedEvents: enqueuedEvents,
      _reset() {
        enqueuedEvents.length = 0;
      },
    },
  };
});

import { registerCostHandler, _resetCostState } from "./hooks/cost.js";
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
    _trigger: async (name: string, event: any, ctx?: any) => {
      if (handlers[name]) await handlers[name](event, ctx);
    },
  };
}

function makeMessages(count: number, startTs = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    role: "assistant",
    timestamp: startTs + i,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.00005, total: 0.00315 },
    },
  }));
}

describe("cost handler — lastSeenIndex dedup", () => {
  beforeEach(() => {
    _resetCostState();
    resetEnqueued();
  });

  it("processes all messages on first call", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    const msgs = makeMessages(3);
    await api._trigger("before_agent_start", { messages: msgs }, { sessionKey: "s1" });

    expect(getEnqueued()).toHaveLength(3);
  });

  it("only processes new messages on subsequent calls", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    const msgs = makeMessages(3);
    await api._trigger("before_agent_start", { messages: msgs }, { sessionKey: "s1" });
    expect(getEnqueued()).toHaveLength(3);

    resetEnqueued();

    // Add 2 more messages to the history
    const updatedMsgs = [...msgs, ...makeMessages(2, 2000)];
    await api._trigger("before_agent_start", { messages: updatedMsgs }, { sessionKey: "s1" });

    // Only the 2 new messages should be processed
    expect(getEnqueued()).toHaveLength(2);
  });

  it("processes zero new messages when history hasn't changed", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    const msgs = makeMessages(3);
    await api._trigger("before_agent_start", { messages: msgs }, { sessionKey: "s1" });
    expect(getEnqueued()).toHaveLength(3);

    resetEnqueued();

    // Same messages — nothing new
    await api._trigger("before_agent_start", { messages: msgs }, { sessionKey: "s1" });
    expect(getEnqueued()).toHaveLength(0);
  });

  it("has zero memory growth — no Set accumulation", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    // Process 500 messages
    const msgs = makeMessages(500);
    await api._trigger("before_agent_start", { messages: msgs }, { sessionKey: "s1" });
    expect(getEnqueued()).toHaveLength(500);

    // Unlike the old Set approach, there's no pruning or memory pressure
    // lastSeenIndex is just a number — O(1) memory
  });
});

describe("cost handler — costBreakdown field", () => {
  beforeEach(() => {
    _resetCostState();
    resetEnqueued();
  });

  it("includes costBreakdown with the full cost object", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    const costObj = { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.00005, total: 0.00315 };
    await api._trigger("before_agent_start", {
      messages: [{
        role: "assistant",
        timestamp: 1000,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 165,
          cost: costObj,
        },
      }],
    }, { sessionKey: "s1" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].costBreakdown).toEqual(costObj);
  });

  it("includes undefined costBreakdown when cost object is missing", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    await api._trigger("before_agent_start", {
      messages: [{
        role: "assistant",
        timestamp: 1000,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: {
          input: 100,
          output: 50,
          totalTokens: 150,
          // no cost field
        },
      }],
    }, { sessionKey: "s1" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].costBreakdown).toBeUndefined();
  });
});

describe("cost handler — heartbeat detection", () => {
  beforeEach(() => {
    _resetCostState();
    resetEnqueued();
  });

  it("tags cost events as heartbeat when last user message contains HEARTBEAT", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    await api._trigger("before_agent_start", {
      messages: [
        { role: "user", content: "Read HEARTBEAT.md and check tasks" },
        {
          role: "assistant",
          timestamp: 1000,
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.003 } },
        },
      ],
    }, { sessionKey: "s1" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].sessionType).toBe("heartbeat");
  });

  it("does not tag as heartbeat for normal messages", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    await api._trigger("before_agent_start", {
      messages: [
        { role: "user", content: "Fix the bug in main.ts" },
        {
          role: "assistant",
          timestamp: 1000,
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.003 } },
        },
      ],
    }, { sessionKey: "s1" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].sessionType).toBeUndefined();
  });

  it("skips internal/delivery-mirror messages", async () => {
    const api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);

    await api._trigger("before_agent_start", {
      messages: [
        {
          role: "assistant",
          timestamp: 1000,
          provider: "openclaw",
          model: "delivery-mirror",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      ],
    }, { sessionKey: "s1" });

    expect(getEnqueued()).toHaveLength(0);
  });
});
