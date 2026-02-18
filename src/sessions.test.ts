/**
 * Tests for session handlers — loop detection via messageCount > 100.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { registerSessionHandlers } from "./hooks/sessions.js";
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
    _trigger: async (name: string, event: any, ctx?: any) => {
      if (handlers[name]) await handlers[name](event, ctx);
    },
  };
}

describe("session handlers — loop detection", () => {
  beforeEach(() => {
    resetEnqueued();
  });

  it("emits session_loop_warning alert when messageCount > 100", async () => {
    const api = makeApi();
    registerSessionHandlers(api);

    await api._trigger("session_end", {
      sessionId: "sess-1",
      messageCount: 150,
      durationMs: 600_000,
    }, { agentId: "main", sessionId: "sess-1" });

    const events = getEnqueued();
    // session_end + alert
    expect(events).toHaveLength(2);

    const alert = events.find((e: any) => e.type === "alert");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("warning");
    expect(alert.pattern).toBe("session_loop_warning");
    expect(alert.messageCount).toBe(150);
  });

  it("does NOT emit loop warning when messageCount <= 100", async () => {
    const api = makeApi();
    registerSessionHandlers(api);

    await api._trigger("session_end", {
      sessionId: "sess-2",
      messageCount: 100,
      durationMs: 600_000,
    }, { agentId: "main", sessionId: "sess-2" });

    const events = getEnqueued();
    // Only session_end, no alert
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_end");
  });

  it("does NOT emit loop warning when messageCount is 50 (even with high rate)", async () => {
    const api = makeApi();
    registerSessionHandlers(api);

    // Old logic would catch this (50 messages in 1 minute = 50 msg/min > 30)
    // New logic: 50 <= 100, so no alert
    await api._trigger("session_end", {
      sessionId: "sess-3",
      messageCount: 50,
      durationMs: 60_000,
    }, { agentId: "main", sessionId: "sess-3" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_end");
  });

  it("emits session_start events correctly", async () => {
    const api = makeApi();
    registerSessionHandlers(api);

    await api._trigger("session_start", {
      sessionId: "sess-4",
      resumedFrom: "sess-3",
    }, { agentId: "main", sessionId: "sess-4" });

    const events = getEnqueued();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_start");
    expect(events[0].sessionId).toBe("sess-4");
    expect(events[0].resumedFrom).toBe("sess-3");
  });
});
