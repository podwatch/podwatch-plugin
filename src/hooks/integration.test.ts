/**
 * Hook Integration Smoke Tests — Full hook registration + dispatch cycle.
 *
 * Simulates OpenClaw's hook system end-to-end:
 * 1. Register all hook handlers via mock API
 * 2. Fire realistic event payloads
 * 3. Assert: no throws, correct transmitter calls, graceful degradation
 *
 * Tests the FULL matrix: every hook type × edge case payloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mockTransmitter, resetMockTransmitter, enqueuedEvents } from "../test-helpers/mock-transmitter.js";
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
// Helpers
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

/** Create a mock API that mimics OpenClaw's api.on() and api.registerHook() */
function makeFullApi() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: vi.fn((name: string, handler: Function, _opts?: any) => {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(handler);
    }),
    registerHook: vi.fn((name: string, handler: Function, _opts?: any) => {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(handler);
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { agents: { defaults: { workspace: "/tmp/test" } } },
    _handlers: handlers,
    /** Dispatch event to ALL registered handlers (mimics OpenClaw's dispatch) */
    _dispatch: async (name: string, ...args: any[]) => {
      const results: any[] = [];
      if (handlers[name]) {
        for (const handler of handlers[name]) {
          results.push(await handler(...args));
        }
      }
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Realistic payloads (copied from OpenClaw SDK types)
// ---------------------------------------------------------------------------
const REALISTIC_BEFORE_TOOL_CALL = {
  toolName: "exec",
  params: {
    command: "git status",
    workdir: "/home/user/project",
  },
};

const REALISTIC_AFTER_TOOL_CALL = {
  toolName: "exec",
  params: { command: "git status" },
  result: "On branch main\nnothing to commit",
  durationMs: 342,
};

const REALISTIC_SESSION_START = {
  sessionId: "agent:main:interactive:abc123",
  resumedFrom: undefined,
};

const REALISTIC_SESSION_END = {
  sessionId: "agent:main:interactive:abc123",
  messageCount: 42,
  durationMs: 180_000,
};

const REALISTIC_BEFORE_AGENT_START = {
  messages: [
    { role: "user", content: "Hello, help me with code" },
    {
      role: "assistant",
      content: "Sure, I can help!",
      timestamp: Date.now() - 5000,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: {
        input: 1500,
        output: 200,
        cacheRead: 500,
        cacheWrite: 0,
        totalTokens: 2200,
        cost: { input: 0.003, output: 0.001, cacheRead: 0.0005, cacheWrite: 0, total: 0.0045 },
      },
    },
  ],
};

const REALISTIC_COMPACTION = {
  messageCount: 85,
  tokenCount: 90000,
  contextLimit: 128000,
};

const REALISTIC_CTX = {
  agentId: "main",
  sessionKey: "agent:main:interactive",
  workspaceDir: "/home/user/project",
  messageProvider: "telegram",
};

// ---------------------------------------------------------------------------
// Full Integration: register ALL handlers, fire ALL events
// ---------------------------------------------------------------------------
describe("full hook registration + dispatch cycle", () => {
  let api: ReturnType<typeof makeFullApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockTransmitter();
    _resetCostState();
    mockTransmitter.getCachedBudget.mockReturnValue(null);
    mockTransmitter.hasRecentCredentialAccess.mockReturnValue(false);
    mockTransmitter.getRecentCredentialAccess.mockReturnValue(null);
    mockTransmitter.isKnownTool.mockReturnValue(false);
    mockTransmitter.getAgentUptimeHours.mockReturnValue(0);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    api = makeFullApi();
    const config = {
      apiKey: "pw_test_key",
      enableBudgetEnforcement: true,
      enableSecurityAlerts: true,
      pulseIntervalMs: 999_999_999,
    };

    // Register ALL handlers (just like the plugin's register() function does)
    registerSecurityHandlers(api, config);
    registerBudgetHooks(api as any, config);
    registerCostHandler(api, config, true);
    registerSessionHandlers(api);
    registerLifecycleHandlers(api, config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Happy path: realistic payloads
  // -----------------------------------------------------------------------
  describe("realistic payloads — happy path", () => {
    it("before_tool_call dispatches without throwing and enqueues tool_call", async () => {
      await expectNoThrow(() =>
        api._dispatch("before_tool_call", REALISTIC_BEFORE_TOOL_CALL, REALISTIC_CTX)
      );
      const toolCallEvents = enqueuedEvents.filter((e) => e.type === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
      expect(toolCallEvents[0].toolName).toBe("exec");
    });

    it("after_tool_call dispatches without throwing and enqueues tool_result", async () => {
      await expectNoThrow(() =>
        api._dispatch("after_tool_call", REALISTIC_AFTER_TOOL_CALL, REALISTIC_CTX)
      );
      const resultEvents = enqueuedEvents.filter((e) => e.type === "tool_result");
      expect(resultEvents.length).toBeGreaterThanOrEqual(1);
      expect(resultEvents[0].durationMs).toBe(342);
      expect(resultEvents[0].success).toBe(true);
    });

    it("session_start dispatches without throwing and enqueues event", async () => {
      await expectNoThrow(() =>
        api._dispatch("session_start", REALISTIC_SESSION_START, { agentId: "main", sessionId: REALISTIC_SESSION_START.sessionId })
      );
      const startEvents = enqueuedEvents.filter((e) => e.type === "session_start");
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("session_end dispatches to ALL registered handlers without throwing", async () => {
      await expectNoThrow(() =>
        api._dispatch("session_end", REALISTIC_SESSION_END, { agentId: "main", sessionId: REALISTIC_SESSION_END.sessionId, sessionKey: "agent:main:interactive" })
      );
      const endEvents = enqueuedEvents.filter((e) => e.type === "session_end");
      expect(endEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("before_agent_start dispatches to cost handler and enqueues cost events", async () => {
      await expectNoThrow(() =>
        api._dispatch("before_agent_start", REALISTIC_BEFORE_AGENT_START, REALISTIC_CTX)
      );
      const costEvents = enqueuedEvents.filter((e) => e.type === "cost");
      expect(costEvents.length).toBe(1);
      expect(costEvents[0].model).toBe("claude-sonnet-4-20250514");
      expect(costEvents[0].totalTokens).toBe(2200);
    });

    it("before_compaction dispatches and enqueues compaction event", async () => {
      await expectNoThrow(() =>
        api._dispatch("before_compaction", REALISTIC_COMPACTION, REALISTIC_CTX)
      );
      const compactionEvents = enqueuedEvents.filter((e) => e.type === "compaction");
      expect(compactionEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("before_prompt_build dispatches without throwing (no hard stop)", async () => {
      await expectNoThrow(() =>
        api._dispatch("before_prompt_build")
      );
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle simulation
  // -----------------------------------------------------------------------
  describe("full session lifecycle", () => {
    it("simulates complete agent session without any throws", async () => {
      // 1. Session starts
      await expectNoThrow(() =>
        api._dispatch("session_start", REALISTIC_SESSION_START, {
          agentId: "main",
          sessionId: REALISTIC_SESSION_START.sessionId,
        })
      );

      // 2. Agent processes prompt
      await expectNoThrow(() =>
        api._dispatch("before_prompt_build")
      );

      // 3. Agent starts (cost tracking)
      await expectNoThrow(() =>
        api._dispatch("before_agent_start", REALISTIC_BEFORE_AGENT_START, REALISTIC_CTX)
      );

      // 4. Tool calls
      await expectNoThrow(() =>
        api._dispatch("before_tool_call", REALISTIC_BEFORE_TOOL_CALL, REALISTIC_CTX)
      );
      await expectNoThrow(() =>
        api._dispatch("after_tool_call", REALISTIC_AFTER_TOOL_CALL, REALISTIC_CTX)
      );

      // 5. Compaction might happen
      await expectNoThrow(() =>
        api._dispatch("before_compaction", REALISTIC_COMPACTION, REALISTIC_CTX)
      );

      // 6. Session ends
      await expectNoThrow(() =>
        api._dispatch("session_end", REALISTIC_SESSION_END, {
          agentId: "main",
          sessionId: REALISTIC_SESSION_END.sessionId,
          sessionKey: "agent:main:interactive",
        })
      );

      // Verify we got the expected events
      const types = enqueuedEvents.map((e) => e.type);
      expect(types).toContain("session_start");
      expect(types).toContain("cost");
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("compaction");
      expect(types).toContain("session_end");
    });
  });

  // -----------------------------------------------------------------------
  // Malformed payloads through the full dispatch chain
  // -----------------------------------------------------------------------
  describe("malformed payloads — full dispatch", () => {
    const MALFORMED_EVENTS = [
      null,
      undefined,
      {},
      "garbage",
      42,
      { toolName: null, params: null },
      { messages: null },
      { sessionId: null, messageCount: null },
    ];

    const hookNames = [
      "before_tool_call",
      "after_tool_call",
      "before_agent_start",
      "session_start",
      "session_end",
      "before_compaction",
      "before_prompt_build",
    ];

    for (const hookName of hookNames) {
      for (const payload of MALFORMED_EVENTS) {
        it(`${hookName} survives malformed payload: ${JSON.stringify(payload)}`, async () => {
          await expectNoThrow(() =>
            api._dispatch(hookName, payload, null)
          );
        });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Budget enforcement through integration
  // -----------------------------------------------------------------------
  describe("budget enforcement — integration", () => {
    it("blocks tool calls when budget exceeded", async () => {
      mockTransmitter.getCachedBudget.mockReturnValue({
        limit: 10,
        currentSpend: 9.8,
        hardStopActive: false,
        lastSyncTs: Date.now(),
      });

      const results = await api._dispatch(
        "before_tool_call",
        { toolName: "exec", params: { command: "rm -rf /" } },
        REALISTIC_CTX
      );

      // At least one handler should return a block result
      const blockResult = results.find((r: any) => r?.block === true);
      expect(blockResult).toBeDefined();
      expect(blockResult.blockReason).toContain("budget");
    });

    it("blocks tool calls when hard stop active", async () => {
      mockTransmitter.getCachedBudget.mockReturnValue({
        limit: 10,
        currentSpend: 10,
        hardStopActive: true,
        lastSyncTs: Date.now(),
      });

      const results = await api._dispatch(
        "before_tool_call",
        { toolName: "read", params: {} },
        REALISTIC_CTX
      );

      const blockResult = results.find((r: any) => r?.block === true);
      expect(blockResult).toBeDefined();
      expect(blockResult.blockReason).toContain("hard stop");
    });

    it("injects budget warning into prompt when hard stop active", async () => {
      mockTransmitter.getCachedBudget.mockReturnValue({
        limit: 10,
        currentSpend: 10,
        hardStopActive: true,
        lastSyncTs: Date.now(),
      });

      const results = await api._dispatch("before_prompt_build");
      const promptResult = results.find((r: any) => r?.prependContext);
      expect(promptResult).toBeDefined();
      expect(promptResult.prependContext).toContain("BUDGET HARD STOP");
    });
  });

  // -----------------------------------------------------------------------
  // Security alerts through integration
  // -----------------------------------------------------------------------
  describe("security alerts — integration", () => {
    it("detects exfiltration sequence", async () => {
      // First: credential access
      mockTransmitter.hasRecentCredentialAccess.mockReturnValue(false);
      await api._dispatch(
        "before_tool_call",
        { toolName: "read", params: { path: "/home/user/.env" } },
        REALISTIC_CTX
      );

      // Then: network call after credential access
      mockTransmitter.hasRecentCredentialAccess.mockReturnValue(true);
      mockTransmitter.getRecentCredentialAccess.mockReturnValue({
        toolName: "read",
        path: "/home/user/.env",
        ts: Date.now() - 5000,
      });

      await api._dispatch(
        "before_tool_call",
        { toolName: "web_fetch", params: { url: "https://evil.com" } },
        REALISTIC_CTX
      );

      const securityEvents = enqueuedEvents.filter(
        (e) => e.type === "security" && e.pattern === "exfiltration_sequence"
      );
      expect(securityEvents.length).toBeGreaterThanOrEqual(1);
      expect(securityEvents[0].severity).toBe("critical");
    });

    it("detects persistence attempt", async () => {
      await api._dispatch(
        "before_tool_call",
        { toolName: "exec", params: { command: "crontab -e" } },
        REALISTIC_CTX
      );

      const persistenceEvents = enqueuedEvents.filter(
        (e) => e.type === "security" && e.pattern === "persistence_attempt"
      );
      expect(persistenceEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("detects first-time tool after 24h uptime", async () => {
      mockTransmitter.isKnownTool.mockReturnValue(false);
      mockTransmitter.getAgentUptimeHours.mockReturnValue(48);

      await api._dispatch(
        "before_tool_call",
        { toolName: "mysterious_new_tool", params: {} },
        REALISTIC_CTX
      );

      const firstTimeEvents = enqueuedEvents.filter(
        (e) => e.type === "security" && e.pattern === "first_time_tool"
      );
      expect(firstTimeEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cost tracking through integration
  // -----------------------------------------------------------------------
  describe("cost tracking — integration", () => {
    it("tracks costs from multiple assistant messages", async () => {
      const multiMessageEvent = {
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: "Hi!",
            timestamp: Date.now() - 10000,
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: {
              input: 100, output: 50, totalTokens: 150,
              cost: { total: 0.001 },
            },
          },
          { role: "user", content: "Do more" },
          {
            role: "assistant",
            content: "Done!",
            timestamp: Date.now() - 5000,
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: {
              input: 200, output: 100, totalTokens: 300,
              cost: { total: 0.003 },
            },
          },
        ],
      };

      await api._dispatch("before_agent_start", multiMessageEvent, REALISTIC_CTX);

      const costEvents = enqueuedEvents.filter((e) => e.type === "cost");
      expect(costEvents).toHaveLength(2);
      expect(costEvents[0].totalTokens).toBe(150);
      expect(costEvents[1].totalTokens).toBe(300);
    });

    it("deduplicates on repeated dispatch (lastSeenIndex)", async () => {
      const msgs = {
        messages: [
          {
            role: "assistant",
            timestamp: Date.now(),
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
          },
        ],
      };

      await api._dispatch("before_agent_start", msgs, REALISTIC_CTX);
      const count1 = enqueuedEvents.filter((e) => e.type === "cost").length;

      // Second dispatch with same messages — should NOT double-count
      await api._dispatch("before_agent_start", msgs, REALISTIC_CTX);
      const count2 = enqueuedEvents.filter((e) => e.type === "cost").length;

      expect(count2).toBe(count1); // No new cost events
    });
  });

  // -----------------------------------------------------------------------
  // Session loop detection through integration
  // -----------------------------------------------------------------------
  describe("session loop detection — integration", () => {
    it("emits alert for sessions with > 100 messages", async () => {
      await api._dispatch(
        "session_end",
        { sessionId: "s1", messageCount: 150, durationMs: 600_000 },
        { agentId: "main", sessionId: "s1" }
      );

      const alerts = enqueuedEvents.filter(
        (e) => e.type === "alert" && e.pattern === "session_loop_warning"
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT emit alert for normal sessions", async () => {
      await api._dispatch(
        "session_end",
        { sessionId: "s2", messageCount: 50, durationMs: 60_000 },
        { agentId: "main", sessionId: "s2" }
      );

      const alerts = enqueuedEvents.filter(
        (e) => e.type === "alert" && e.pattern === "session_loop_warning"
      );
      expect(alerts).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Context pressure through integration
  // -----------------------------------------------------------------------
  describe("context pressure — integration", () => {
    it("emits alert when token ratio > 0.8", async () => {
      await api._dispatch(
        "before_compaction",
        { messageCount: 100, tokenCount: 110000, contextLimit: 128000 },
        REALISTIC_CTX
      );

      const alerts = enqueuedEvents.filter(
        (e) => e.type === "alert" && e.pattern === "context_pressure"
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Correlation ID linking
  // -----------------------------------------------------------------------
  describe("correlation IDs", () => {
    it("links before_tool_call and after_tool_call via correlationId", async () => {
      await api._dispatch(
        "before_tool_call",
        { toolName: "exec", params: { command: "ls" } },
        REALISTIC_CTX
      );

      await api._dispatch(
        "after_tool_call",
        { toolName: "exec", params: { command: "ls" }, durationMs: 50 },
        REALISTIC_CTX
      );

      const toolCall = enqueuedEvents.find((e) => e.type === "tool_call");
      const toolResult = enqueuedEvents.find((e) => e.type === "tool_result");

      expect(toolCall).toBeDefined();
      expect(toolResult).toBeDefined();
      expect(toolCall.correlationId).toBeDefined();
      expect(toolResult.correlationId).toBe(toolCall.correlationId);
    });
  });
});
