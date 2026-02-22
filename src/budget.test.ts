/**
 * Tests for budget hard stop hooks — before_model_resolve, before_prompt_build,
 * and hard stop tool blocking in security.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock variables for transmitter
const {
  mockEnqueue,
  mockGetCachedBudget,
  mockMarkCredentialAccess,
  mockHasRecentCredentialAccess,
  mockGetRecentCredentialAccess,
  mockIsKnownTool,
  mockRecordToolSeen,
  mockGetAgentUptimeHours,
  mockUpdateBudgetFromResponse,
} = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  mockGetCachedBudget: vi.fn().mockReturnValue(null),
  mockMarkCredentialAccess: vi.fn(),
  mockHasRecentCredentialAccess: vi.fn().mockReturnValue(false),
  mockGetRecentCredentialAccess: vi.fn().mockReturnValue(null),
  mockIsKnownTool: vi.fn().mockReturnValue(false),
  mockRecordToolSeen: vi.fn(),
  mockGetAgentUptimeHours: vi.fn().mockReturnValue(0),
  mockUpdateBudgetFromResponse: vi.fn(),
}));

vi.mock("./transmitter.js", () => ({
  transmitter: {
    enqueue: mockEnqueue,
    getCachedBudget: mockGetCachedBudget,
    markCredentialAccess: mockMarkCredentialAccess,
    hasRecentCredentialAccess: mockHasRecentCredentialAccess,
    getRecentCredentialAccess: mockGetRecentCredentialAccess,
    isKnownTool: mockIsKnownTool,
    recordToolSeen: mockRecordToolSeen,
    getAgentUptimeHours: mockGetAgentUptimeHours,
    updateBudgetFromResponse: mockUpdateBudgetFromResponse,
  },
}));

import { registerBudgetHooks, findCheapestModel } from "./hooks/budget.js";
import { registerSecurityHandlers } from "./hooks/security.js";

// ---------------------------------------------------------------------------
// Helper: mock API with registerHook capturing
// ---------------------------------------------------------------------------
function makeMockApi(config: Record<string, unknown> = {}) {
  const hooks: Record<string, Function> = {};
  return {
    on: vi.fn(),
    registerHook: vi.fn((name: string, handler: Function, _opts?: any) => {
      hooks[name] = handler;
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config,
    pluginConfig: {},
    version: "1.0.2",
    _hooks: hooks,
    _trigger: async (name: string, ...args: any[]) => {
      if (hooks[name]) return hooks[name](...args);
    },
  };
}

// ---------------------------------------------------------------------------
// findCheapestModel (pure function)
// ---------------------------------------------------------------------------
describe("findCheapestModel", () => {
  it("returns null when only one model is configured", () => {
    const config = {
      agents: { defaults: { model: { primary: "anthropic/opus" }, models: { "anthropic/opus": { alias: "opus" } } } },
    };
    expect(findCheapestModel(config)).toBeNull();
  });

  it("returns cheapest model from multiple options", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4" },
          models: {
            "anthropic/claude-opus-4": { alias: "opus" },
            "anthropic/claude-haiku-3": { alias: "haiku" },
            "anthropic/claude-sonnet-4": { alias: "sonnet" },
          },
        },
      },
    };

    const result = findCheapestModel(config);
    expect(result).not.toBeNull();
    // haiku is cheaper than sonnet and opus
    expect(result!.model).toBe("anthropic/claude-haiku-3");
  });

  it("finds models from providers config", () => {
    const config = {
      models: {
        providers: {
          anthropic: { models: ["claude-opus-4", "claude-haiku-3"] },
        },
      },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4" }, models: {} } },
    };

    const result = findCheapestModel(config);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("anthropic/claude-haiku-3");
  });

  it("returns null for empty config", () => {
    expect(findCheapestModel({})).toBeNull();
  });

  it("prefers haiku over flash over sonnet", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4" },
          models: {
            "anthropic/claude-opus-4": {},
            "google/gemini-flash": {},
            "anthropic/claude-sonnet-4": {},
            "anthropic/claude-haiku-3": {},
          },
        },
      },
    };

    const result = findCheapestModel(config);
    expect(result!.model).toBe("anthropic/claude-haiku-3");
  });

  it("does not return the current primary model as cheapest", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-haiku-3" },
          models: {
            "anthropic/claude-haiku-3": {},
            "anthropic/claude-sonnet-4": {},
          },
        },
      },
    };

    const result = findCheapestModel(config);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("anthropic/claude-sonnet-4");
  });
});

// ---------------------------------------------------------------------------
// before_model_resolve hook
// ---------------------------------------------------------------------------
describe("before_model_resolve", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetCachedBudget.mockReturnValue(null);
  });

  it("returns model override when hard stop active and cheaper model exists", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10,
      currentSpend: 10,
      dailySpend: 10,
      dailyLimit: 10,
      monthlySpend: 50,
      monthlyLimit: 100,
      hardStopEnabled: true,
      hardStopActive: true,
      lastSyncTs: Date.now(),
    });

    const api = makeMockApi({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4" },
          models: {
            "anthropic/claude-opus-4": { alias: "opus" },
            "anthropic/claude-haiku-3": { alias: "haiku" },
          },
        },
      },
    });

    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_model_resolve");
    expect(result).toEqual({
      modelOverride: "anthropic/claude-haiku-3",
      providerOverride: "anthropic",
    });
  });

  it("returns void when hard stop not active", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10,
      currentSpend: 5,
      dailySpend: 5,
      dailyLimit: 10,
      monthlySpend: 30,
      monthlyLimit: 100,
      hardStopEnabled: true,
      hardStopActive: false,
      lastSyncTs: Date.now(),
    });

    const api = makeMockApi({
      agents: { defaults: { model: { primary: "opus" }, models: { opus: {}, haiku: {} } } },
    });

    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_model_resolve");
    expect(result).toBeUndefined();
  });

  it("returns void when budget is null", async () => {
    mockGetCachedBudget.mockReturnValue(null);

    const api = makeMockApi({});
    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_model_resolve");
    expect(result).toBeUndefined();
  });

  it("returns void when only one model configured (no cheaper alternative)", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const api = makeMockApi({
      agents: { defaults: { model: { primary: "anthropic/opus" }, models: { "anthropic/opus": {} } } },
    });

    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: true });

    const result = await api._trigger("before_model_resolve");
    expect(result).toBeUndefined();
  });

  it("skips when budget enforcement disabled", async () => {
    mockGetCachedBudget.mockReturnValue({
      limit: 10, currentSpend: 10, dailySpend: 10, dailyLimit: 10,
      monthlySpend: 50, monthlyLimit: 100,
      hardStopEnabled: true, hardStopActive: true, lastSyncTs: Date.now(),
    });

    const api = makeMockApi({
      agents: { defaults: { model: { primary: "opus" }, models: { opus: {}, haiku: {} } } },
    });

    registerBudgetHooks(api as any, { apiKey: "test", enableBudgetEnforcement: false });

    const result = await api._trigger("before_model_resolve");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// before_prompt_build hook
// ---------------------------------------------------------------------------
describe("before_prompt_build", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    vi.resetAllMocks();
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

    const calls = mockApi.registerHook.mock.calls;
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

    // Should not block — no hard stop, spend below 95%
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
