/**
 * Tests for budget hard stop hooks — before_prompt_build
 * and hard stop tool blocking in security.
 *
 * No model downgrade — we can't know what providers the user has configured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Use shared transmitter mock (Bun runs all files in one process — mocks leak)
import { mockTransmitter, resetMockTransmitter } from "./test-helpers/mock-transmitter.js";
vi.mock("./transmitter.js", () => ({ transmitter: mockTransmitter }));

// Alias mock functions for readability in tests
const mockEnqueue = mockTransmitter.enqueue;
const mockGetCachedBudget = mockTransmitter.getCachedBudget;
const mockHasRecentCredentialAccess = mockTransmitter.hasRecentCredentialAccess;
const mockGetRecentCredentialAccess = mockTransmitter.getRecentCredentialAccess;
const mockIsKnownTool = mockTransmitter.isKnownTool;
const mockGetAgentUptimeHours = mockTransmitter.getAgentUptimeHours;

import { registerBudgetHooks } from "./hooks/budget.js";
import { registerSecurityHandlers } from "./hooks/security.js";

// ---------------------------------------------------------------------------
// Helper: mock API with registerHook capturing
// ---------------------------------------------------------------------------
function makeMockApi(config: Record<string, unknown> = {}) {
  const hooks: Record<string, Function> = {};
  const onFn = vi.fn((name: string, handler: Function, _opts?: any) => {
    hooks[name] = handler;
  });
  return {
    on: onFn,
    registerHook: vi.fn((name: string, handler: Function, _opts?: any) => {
      hooks[name] = handler;
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config,
    pluginConfig: {},
    version: "1.1.0",
    _hooks: hooks,
    _trigger: async (name: string, ...args: any[]) => {
      if (hooks[name]) return hooks[name](...args);
    },
  };
}

// ---------------------------------------------------------------------------
// before_prompt_build hook
// ---------------------------------------------------------------------------
describe("before_prompt_build", () => {
  beforeEach(() => {
    resetMockTransmitter();
    mockGetCachedBudget.mockReturnValue(null);
  });

  it("returns prepend context when hard stop active", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const api = makeMockApi({});
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_prompt_build");
    expect(result).toHaveProperty("prependContext");
    expect(result.prependContext).toContain("BUDGET HARD STOP ACTIVE");
    expect(result.prependContext).toContain("podwatch.app/costs");
  });

  it("returns void when hard stop not active", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 5, dailySpend: 5, dailyLimit: 10,
      monthlySpend: 30, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: false, lastSyncTs: Date.now(),
    });

    const api = makeMockApi({});
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_prompt_build");
    expect(result).toBeUndefined();
  });

  it("returns void when budget is null", async () => {
    mockGetCachedBudget.mockReturnValue(null);

    const api = makeMockApi({});
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_prompt_build");
    expect(result).toBeUndefined();
  });

  it("returns void when budget enforcement disabled", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const api = makeMockApi({});
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: false });

    const result = await api._trigger("before_prompt_build");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hard stop blocking in before_tool_call (security.ts)
// ---------------------------------------------------------------------------
describe("hard stop tool blocking (security.ts)", () => {
  let beforeToolCallHandler: (event: any, ctx: any) => Promise<any>;
  const defaultCtx = { sessionKey: "agent:main:interactive", agentId: "main" };

  beforeEach(() => {
    resetMockTransmitter();
    mockGetCachedBudget.mockReturnValue(null);
    mockHasRecentCredentialAccess.mockReturnValue(false);
    mockGetRecentCredentialAccess.mockReturnValue(null);
    mockIsKnownTool.mockReturnValue(false);
    mockGetAgentUptimeHours.mockReturnValue(0);

    const mockApi = {
      on: vi.fn(),
      registerHook: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    registerSecurityHandlers(mockApi, {
      apiKey: "test",
      enableBudgetEnforcement: true,
      enableSecurityAlerts: true,
    });

    // Extract handler from api.on (security.ts uses api.on, not registerHook)
    const calls = mockApi.on.mock.calls;
    const beforeCall = calls.find((c: any) => c[0] === "before_tool_call");
    beforeToolCallHandler = beforeCall![1];
  });

  it("blocks ALL tools when hard stop active", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const result = await beforeToolCallHandler(
      { toolName: "read", params: {} },
      defaultCtx,
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Podwatch: Budget hard stop active. Resume at podwatch.app/costs",
    });
  });

  it("blocks tools even when spend is low if hard stop active", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 1, dailySpend: 1, dailyLimit: 10,
      monthlySpend: 5, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const result = await beforeToolCallHandler(
      { toolName: "exec", params: { command: "ls" } },
      defaultCtx,
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Podwatch: Budget hard stop active. Resume at podwatch.app/costs",
    });
  });

  it("emits budget_blocked event with hardStop flag", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    await beforeToolCallHandler(
      { toolName: "read", params: {} },
      defaultCtx,
    );

    const blockedEvent = mockEnqueue.mock.calls.find(
      (c: any) => c[0].type === "budget_blocked",
    );
    expect(blockedEvent).toBeTruthy();
    expect(blockedEvent![0].hardStop).toBe(true);
  });

  it("does NOT block when hardStopActive is false", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 5, dailySpend: 5, dailyLimit: 10,
      monthlySpend: 30, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: false, lastSyncTs: Date.now(),
    });

    const result = await beforeToolCallHandler(
      { toolName: "read", params: {} },
      defaultCtx,
    );

    expect(result?.block).not.toBe(true);
  });

  it("falls through to regular budget check when hardStop inactive but spend >= 95%", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 9.5, dailySpend: 9.5, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: false, hardStopActive: false, lastSyncTs: Date.now(),
    });

    const result = await beforeToolCallHandler(
      { toolName: "read", params: {} },
      defaultCtx,
    );

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Daily budget of $10.00 reached"),
    });
  });
});
