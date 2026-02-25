/**
 * Hook Payload Edge Case Tests — Adversarial inputs for ALL hook handlers.
 *
 * Regression suite for the `redactParams(null)` crash that killed tool_call
 * event tracking in production. Every handler MUST survive garbage input.
 *
 * Rule: A hook handler must NEVER throw. Period.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mockTransmitter, resetMockTransmitter } from "../test-helpers/mock-transmitter.js";
vi.mock("../transmitter.js", () => ({ transmitter: mockTransmitter }));

vi.mock("../scanner.js", () => ({
  scanSkillsAndPlugins: vi.fn().mockResolvedValue({ skills: [], plugins: [] }),
}));

import { registerSecurityHandlers } from "./security.js";
import { registerBudgetHooks } from "./budget.js";
import { registerCostHandler, _resetCostState } from "./cost.js";
import { registerSessionHandlers } from "./sessions.js";
import { registerLifecycleHandlers } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Helper: assert async function doesn't throw
// ---------------------------------------------------------------------------
async function expectNoThrow(fn: () => Promise<any>): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeUndefined();
}

// ---------------------------------------------------------------------------
// Adversarial payloads
// ---------------------------------------------------------------------------
const ADVERSARIAL_EVENTS = [
  { label: "null event", value: null },
  { label: "undefined event", value: undefined },
  { label: "empty object", value: {} },
  { label: "string event", value: "garbage" },
  { label: "number event", value: 42 },
  { label: "boolean event", value: true },
  { label: "array event", value: [1, 2, 3] },
  { label: "event with null params", value: { toolName: "read", params: null } },
  { label: "event with undefined params", value: { toolName: "read", params: undefined } },
  { label: "event with string params", value: { toolName: "read", params: "not-an-object" } },
  { label: "event with number params", value: { toolName: "read", params: 123 } },
  { label: "event with boolean params", value: { toolName: "read", params: true } },
  { label: "event with array params", value: { toolName: "read", params: [1, 2] } },
  { label: "event with null toolName", value: { toolName: null, params: {} } },
  { label: "event with undefined toolName", value: { toolName: undefined, params: {} } },
  { label: "event with empty toolName", value: { toolName: "", params: {} } },
  { label: "event with number toolName", value: { toolName: 42, params: {} } },
  { label: "event with no params key", value: { toolName: "read" } },
  { label: "event with no toolName key", value: { params: {} } },
  { label: "event with nested null", value: { toolName: "read", params: { nested: null } } },
  { label: "event with deeply nested nulls", value: { toolName: "read", params: { a: { b: { c: null } } } } },
  { label: "event with nested undefined", value: { toolName: "read", params: { key: undefined } } },
  { label: "event with prototype pollution attempt", value: { toolName: "read", params: { __proto__: { admin: true } } } },
];

const ADVERSARIAL_CONTEXTS = [
  { label: "null ctx", value: null },
  { label: "undefined ctx", value: undefined },
  { label: "empty ctx", value: {} },
  { label: "string ctx", value: "bad" },
  { label: "number ctx", value: 0 },
  { label: "ctx with null sessionKey", value: { sessionKey: null, agentId: "main" } },
  { label: "ctx with undefined sessionKey", value: { sessionKey: undefined, agentId: undefined } },
  { label: "valid ctx", value: { sessionKey: "agent:main:interactive", agentId: "main" } },
];

// ---------------------------------------------------------------------------
// Helper: create a mock API that captures handlers via api.on
// ---------------------------------------------------------------------------
function makeApi() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((name: string, handler: Function, _opts?: any) => {
      handlers[name] = handler;
    }),
    registerHook: vi.fn((name: string, handler: Function, _opts?: any) => {
      handlers[name] = handler;
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { agents: { defaults: { workspace: "/tmp/test" } } },
    _handlers: handlers,
    _trigger: async (name: string, ...args: any[]) => {
      if (handlers[name]) return handlers[name](...args);
    },
  };
}

// ---------------------------------------------------------------------------
// Security handlers — before_tool_call, after_tool_call, session_end
// ---------------------------------------------------------------------------
describe("security handlers — adversarial payloads", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    resetMockTransmitter();
    mockTransmitter.getCachedBudget.mockReturnValue(null);
    mockTransmitter.hasRecentCredentialAccess.mockReturnValue(false);
    mockTransmitter.getRecentCredentialAccess.mockReturnValue(null);
    mockTransmitter.isKnownTool.mockReturnValue(false);
    mockTransmitter.getAgentUptimeHours.mockReturnValue(0);

    api = makeApi();
    registerSecurityHandlers(api, {
      apiKey: "test",
      enableBudgetEnforcement: true,
      enableSecurityAlerts: true,
    });
  });

  describe("before_tool_call", () => {
    for (const ev of ADVERSARIAL_EVENTS) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          await expectNoThrow(() => api._trigger("before_tool_call", ev.value, ctx.value));
        });
      }
    }
  });

  describe("after_tool_call", () => {
    for (const ev of ADVERSARIAL_EVENTS) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          await expectNoThrow(() => api._trigger("after_tool_call", ev.value, ctx.value));
        });
      }
    }
  });

  describe("session_end (security cleanup)", () => {
    for (const ctx of ADVERSARIAL_CONTEXTS) {
      it(`survives null event + ${ctx.label}`, async () => {
        await expectNoThrow(() => api._trigger("session_end", null, ctx.value));
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Budget handlers — before_prompt_build
// ---------------------------------------------------------------------------
describe("budget handlers — adversarial payloads", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    resetMockTransmitter();
    mockTransmitter.getCachedBudget.mockReturnValue(null);
    api = makeApi();
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });
  });

  it("survives when getCachedBudget returns null", async () => {
    mockTransmitter.getCachedBudget.mockReturnValue(null);
    await expectNoThrow(() => api._trigger("before_prompt_build"));
  });

  it("survives when getCachedBudget returns undefined", async () => {
    mockTransmitter.getCachedBudget.mockReturnValue(undefined);
    await expectNoThrow(() => api._trigger("before_prompt_build"));
  });

  it("survives when getCachedBudget returns garbage string", async () => {
    mockTransmitter.getCachedBudget.mockReturnValue("garbage");
    await expectNoThrow(() => api._trigger("before_prompt_build"));
  });

  it("survives when getCachedBudget returns malformed object", async () => {
    mockTransmitter.getCachedBudget.mockReturnValue({ hardStopActive: "yes" });
    await expectNoThrow(() => api._trigger("before_prompt_build"));
  });

  it("survives when getCachedBudget returns number", async () => {
    mockTransmitter.getCachedBudget.mockReturnValue(42);
    await expectNoThrow(() => api._trigger("before_prompt_build"));
  });
});

// ---------------------------------------------------------------------------
// Cost handlers — before_agent_start, session_end
// ---------------------------------------------------------------------------
describe("cost handlers — adversarial payloads", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    _resetCostState();
    resetMockTransmitter();
    api = makeApi();
    registerCostHandler(api, { apiKey: "test" }, true);
  });

  describe("before_agent_start", () => {
    const costEvents = [
      { label: "null event", value: null },
      { label: "undefined event", value: undefined },
      { label: "empty object", value: {} },
      { label: "string event", value: "bad" },
      { label: "number event", value: 42 },
      { label: "messages: null", value: { messages: null } },
      { label: "messages: undefined", value: { messages: undefined } },
      { label: "messages: string", value: { messages: "not-array" } },
      { label: "messages: number", value: { messages: 123 } },
      { label: "messages: empty array", value: { messages: [] } },
      { label: "messages with null entries", value: { messages: [null, undefined, null] } },
      { label: "messages with garbage entries", value: { messages: [42, "bad", true] } },
      { label: "messages with missing usage", value: { messages: [{ role: "assistant" }] } },
      { label: "messages with null usage", value: { messages: [{ role: "assistant", usage: null }] } },
      { label: "messages with empty usage", value: { messages: [{ role: "assistant", usage: {} }] } },
      {
        label: "messages with malformed cost",
        value: { messages: [{ role: "assistant", usage: { input: 100, output: 50, totalTokens: 150, cost: null } }] },
      },
      {
        label: "messages with missing cost.total",
        value: { messages: [{ role: "assistant", provider: "anthropic", model: "claude", usage: { input: 100, output: 50, totalTokens: 150, cost: {} } }] },
      },
    ];

    for (const ev of costEvents) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          _resetCostState();
          await expectNoThrow(() => api._trigger("before_agent_start", ev.value, ctx.value));
        });
      }
    }
  });

  describe("session_end (cost cleanup)", () => {
    for (const ctx of ADVERSARIAL_CONTEXTS) {
      it(`survives null event + ${ctx.label}`, async () => {
        await expectNoThrow(() => api._trigger("session_end", null, ctx.value));
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Session handlers — session_start, session_end
// ---------------------------------------------------------------------------
describe("session handlers — adversarial payloads", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    resetMockTransmitter();
    api = makeApi();
    registerSessionHandlers(api);
  });

  const sessionEvents = [
    { label: "null event", value: null },
    { label: "undefined event", value: undefined },
    { label: "empty object", value: {} },
    { label: "string event", value: "garbage" },
    { label: "number event", value: 42 },
    { label: "event with null sessionId", value: { sessionId: null } },
    { label: "event with no sessionId", value: { messageCount: 50 } },
    { label: "event with null messageCount", value: { sessionId: "s1", messageCount: null } },
    { label: "event with string messageCount", value: { sessionId: "s1", messageCount: "one hundred" } },
    { label: "event with NaN messageCount", value: { sessionId: "s1", messageCount: NaN } },
    { label: "event with negative messageCount", value: { sessionId: "s1", messageCount: -5 } },
    { label: "event with Infinity messageCount", value: { sessionId: "s1", messageCount: Infinity } },
    { label: "valid session_start event", value: { sessionId: "s1", resumedFrom: "s0" } },
    { label: "valid session_end event", value: { sessionId: "s1", messageCount: 50, durationMs: 1000 } },
  ];

  describe("session_start", () => {
    for (const ev of sessionEvents) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          await expectNoThrow(() => api._trigger("session_start", ev.value, ctx.value));
        });
      }
    }
  });

  describe("session_end", () => {
    for (const ev of sessionEvents) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          await expectNoThrow(() => api._trigger("session_end", ev.value, ctx.value));
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle handlers — gateway_start, gateway_stop, before_compaction
// ---------------------------------------------------------------------------
describe("lifecycle handlers — adversarial payloads", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockTransmitter();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    api = makeApi();
    registerLifecycleHandlers(api, { apiKey: "test", pulseIntervalMs: 999_999_999 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const compactionEvents = [
    { label: "null event", value: null },
    { label: "undefined event", value: undefined },
    { label: "empty object", value: {} },
    { label: "string event", value: "garbage" },
    { label: "number event", value: 42 },
    { label: "event with null messageCount", value: { messageCount: null, tokenCount: null } },
    { label: "event with missing fields", value: { tokenCount: 5000 } },
    { label: "event with string tokenCount", value: { messageCount: 10, tokenCount: "many" } },
    { label: "valid compaction event", value: { messageCount: 50, tokenCount: 80000, contextLimit: 100000 } },
  ];

  describe("before_compaction", () => {
    for (const ev of compactionEvents) {
      for (const ctx of ADVERSARIAL_CONTEXTS) {
        it(`survives ${ev.label} + ${ctx.label}`, async () => {
          await expectNoThrow(() => api._trigger("before_compaction", ev.value, ctx.value));
        });
      }
    }
  });

  describe("gateway_start", () => {
    const gatewayEvents = [
      { label: "null event", value: null },
      { label: "undefined event", value: undefined },
      { label: "empty object", value: {} },
      { label: "valid event", value: { port: 3000 } },
    ];

    for (const ev of gatewayEvents) {
      it(`survives ${ev.label}`, async () => {
        await expectNoThrow(() => api._trigger("gateway_start", ev.value));
      });
    }
  });

  describe("gateway_stop", () => {
    it("survives normal call", async () => {
      await expectNoThrow(() => api._trigger("gateway_stop"));
    });

    it("survives with garbage args", async () => {
      await expectNoThrow(() => api._trigger("gateway_stop", null, null));
    });
  });
});
