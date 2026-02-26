import { describe, it, expect, vi, beforeEach } from "vitest";

// Use shared transmitter mock (Bun runs all files in one process — mocks leak)
import { mockTransmitter, resetMockTransmitter } from "./test-helpers/mock-transmitter.js";
vi.mock("./transmitter.js", () => ({ transmitter: mockTransmitter }));

// Alias mock functions for readability in tests
const mockEnqueue = mockTransmitter.enqueue;
const mockGetCachedBudget = mockTransmitter.getCachedBudget;
const mockMarkCredentialAccess = mockTransmitter.markCredentialAccess;
const mockHasRecentCredentialAccess = mockTransmitter.hasRecentCredentialAccess;
const mockGetRecentCredentialAccess = mockTransmitter.getRecentCredentialAccess;
const mockIsKnownTool = mockTransmitter.isKnownTool;
const mockRecordToolSeen = mockTransmitter.recordToolSeen;
const mockGetAgentUptimeHours = mockTransmitter.getAgentUptimeHours;

import { registerSecurityHandlers } from "./hooks/security.js";

describe("security hooks", () => {
  let beforeToolCallHandler: (event: any, ctx: any) => Promise<any>;
  let afterToolCallHandler: (event: any, ctx: any) => Promise<any>;
  const mockApi = {
    on: vi.fn(),
    registerHook: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const defaultCtx = { sessionKey: "agent:main:interactive", agentId: "main" };

  beforeEach(() => {
    resetMockTransmitter();
    mockGetCachedBudget.mockReturnValue(null);
    mockHasRecentCredentialAccess.mockReturnValue(false);
    mockGetRecentCredentialAccess.mockReturnValue(null);
    mockIsKnownTool.mockReturnValue(false);
    mockGetAgentUptimeHours.mockReturnValue(0);

    mockApi.registerHook.mockReset();
    mockApi.on.mockReset();
    registerSecurityHandlers(mockApi, {
      apiKey: "test",
      enableBudgetEnforcement: true,
      enableSecurityAlerts: true,
    });

    // Extract registered handlers via api.on
    const calls = mockApi.on.mock.calls;
    const beforeCall = calls.find((c: any) => c[0] === "before_tool_call");
    const afterCall = calls.find((c: any) => c[0] === "after_tool_call");
    beforeToolCallHandler = beforeCall![1];
    afterToolCallHandler = afterCall![1];
  });

  // -----------------------------------------------------------------------
  // A) Budget enforcement
  // -----------------------------------------------------------------------
  describe("budget enforcement", () => {
    it("blocks when spend >= 95% of limit", async () => {
      mockGetCachedBudget.mockReturnValue({
        limit: 10,
        currentSpend: 9.5,
        lastSyncTs: Date.now(),
      });

      const result = await beforeToolCallHandler(
        { toolName: "read", params: {} },
        defaultCtx
      );

      expect(result).toEqual({
        block: true,
        blockReason: expect.stringContaining("Daily budget of $10.00 reached"),
      });

      // Should enqueue budget_blocked event
      const blockedEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "budget_blocked"
      );
      expect(blockedEvent).toBeTruthy();
    });

    it("does NOT block when spend < 95% of limit", async () => {
      mockGetCachedBudget.mockReturnValue({
        limit: 10,
        currentSpend: 9.0,
        lastSyncTs: Date.now(),
      });

      const result = await beforeToolCallHandler(
        { toolName: "read", params: {} },
        defaultCtx
      );

      expect(result).toBeUndefined();
    });

    it("does NOT block when budget is null", async () => {
      mockGetCachedBudget.mockReturnValue(null);

      const result = await beforeToolCallHandler(
        { toolName: "read", params: {} },
        defaultCtx
      );

      expect(result).toBeUndefined();
    });

    it("does NOT block when limit is 0 (disabled)", async () => {
      mockGetCachedBudget.mockReturnValue({
        limit: 0,
        currentSpend: 5,
        lastSyncTs: Date.now(),
      });

      const result = await beforeToolCallHandler(
        { toolName: "read", params: {} },
        defaultCtx
      );

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // B1) Exfiltration sequence
  // -----------------------------------------------------------------------
  describe("exfiltration detection", () => {
    it("marks credential access when reading .env", async () => {
      await beforeToolCallHandler(
        { toolName: "read", params: { path: "/app/.env" } },
        defaultCtx
      );

      expect(mockMarkCredentialAccess).toHaveBeenCalledWith("read", { path: "/app/.env" });
    });

    it("queues critical alert on network call after credential access", async () => {
      mockHasRecentCredentialAccess.mockReturnValue(true);
      mockGetRecentCredentialAccess.mockReturnValue({
        toolName: "read",
        path: "/app/.env",
        ts: Date.now() - 10_000,
      });

      await beforeToolCallHandler(
        { toolName: "web_fetch", params: { url: "https://evil.com" } },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "security" && c[0].pattern === "exfiltration_sequence"
      );
      expect(securityEvent).toBeTruthy();
      expect(securityEvent![0].severity).toBe("critical");
    });

    it("does NOT alert on network call without prior credential access", async () => {
      mockHasRecentCredentialAccess.mockReturnValue(false);

      await beforeToolCallHandler(
        { toolName: "web_fetch", params: { url: "https://example.com" } },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].pattern === "exfiltration_sequence"
      );
      expect(securityEvent).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // B1b) Persistence attempt
  // -----------------------------------------------------------------------
  describe("persistence detection", () => {
    it("queues high-severity alert for crontab via exec", async () => {
      await beforeToolCallHandler(
        { toolName: "exec", params: { command: "crontab -e" } },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].pattern === "persistence_attempt"
      );
      expect(securityEvent).toBeTruthy();
      expect(securityEvent![0].severity).toBe("high");
    });
  });

  // -----------------------------------------------------------------------
  // B2) First-time tool detection
  // -----------------------------------------------------------------------
  describe("first-time tool detection", () => {
    it("queues medium alert for unknown tool after 24h uptime", async () => {
      mockIsKnownTool.mockReturnValue(false);
      mockGetAgentUptimeHours.mockReturnValue(25);

      await beforeToolCallHandler(
        { toolName: "mysterious_tool", params: {} },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].pattern === "first_time_tool"
      );
      expect(securityEvent).toBeTruthy();
      expect(securityEvent![0].severity).toBe("medium");
    });

    it("does NOT alert for unknown tool before 24h uptime", async () => {
      mockIsKnownTool.mockReturnValue(false);
      mockGetAgentUptimeHours.mockReturnValue(12);

      await beforeToolCallHandler(
        { toolName: "mysterious_tool", params: {} },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].pattern === "first_time_tool"
      );
      expect(securityEvent).toBeUndefined();
    });

    it("does NOT alert for known tool after 24h uptime", async () => {
      mockIsKnownTool.mockReturnValue(true);
      mockGetAgentUptimeHours.mockReturnValue(48);

      await beforeToolCallHandler(
        { toolName: "read", params: {} },
        defaultCtx
      );

      const securityEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].pattern === "first_time_tool"
      );
      expect(securityEvent).toBeUndefined();
    });

    it("always records tool as seen", async () => {
      mockIsKnownTool.mockReturnValue(false);
      mockGetAgentUptimeHours.mockReturnValue(1);

      await beforeToolCallHandler(
        { toolName: "some_tool", params: {} },
        defaultCtx
      );

      expect(mockRecordToolSeen).toHaveBeenCalledWith("some_tool");
    });
  });

  // -----------------------------------------------------------------------
  // B3) Tool call logging
  // -----------------------------------------------------------------------
  describe("tool call logging", () => {
    it("always logs tool_call with redacted params", async () => {
      await beforeToolCallHandler(
        { toolName: "read", params: { path: "/app/index.ts" } },
        defaultCtx
      );

      const toolCallEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_call"
      );
      expect(toolCallEvent).toBeTruthy();
      expect(toolCallEvent![0].toolName).toBe("read");
      expect(toolCallEvent![0].params).toEqual({ path: "/app/index.ts" });
    });
  });

  // -----------------------------------------------------------------------
  // after_tool_call
  // -----------------------------------------------------------------------
  describe("after_tool_call", () => {
    it("queues tool_result with durationMs and success", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, durationMs: 42 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent).toBeTruthy();
      expect(resultEvent![0].durationMs).toBe(42);
      expect(resultEvent![0].success).toBe(true);
      expect(resultEvent![0].error).toBeUndefined();
    });

    it("records error on failure", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, durationMs: 100, error: "Permission denied" },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent).toBeTruthy();
      expect(resultEvent![0].success).toBe(false);
      expect(resultEvent![0].error).toBe("Permission denied");
    });

    it("truncates long error messages", async () => {
      const longError = "x".repeat(1000);
      await afterToolCallHandler(
        { toolName: "exec", params: {}, error: longError },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].error!.length).toBeLessThanOrEqual(500);
    });

    it("captures resultPreview from event.result (string)", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: "Hello world content", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent).toBeTruthy();
      expect(resultEvent![0].resultPreview).toBe("Hello world content");
    });

    it("captures resultPreview from event.result (object)", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, result: { stdout: "ok", code: 0 }, durationMs: 5 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent).toBeTruthy();
      expect(resultEvent![0].resultPreview).toBe('{"stdout":"ok","code":0}');
    });

    it("truncates resultPreview at 200 chars with ellipsis", async () => {
      const longResult = "a".repeat(300);
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: longResult, durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview!.length).toBe(201); // 200 + "…"
      expect(resultEvent![0].resultPreview!.endsWith("…")).toBe(true);
    });

    it("does NOT capture resultPreview when event has error", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, result: "some output", error: "failed", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).toBeUndefined();
    });

    it("does NOT capture resultPreview when event.result is null", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: null, durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).toBeUndefined();
    });

    it("redacts sk- tokens in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: "key: sk-proj-abcdefghijklmnop12345", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("sk-proj");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });

    it("redacts token= patterns in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, result: "url?token=abc123secret&foo=bar", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("abc123secret");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });

    it("redacts GitHub PATs in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("ghp_");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });

    it("redacts Bearer tokens in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, result: "Authorization: Bearer mySecretToken123", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("mySecretToken123");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });

    it("redacts JWTs in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "exec", params: {}, result: "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("eyJhbGci");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });

    it("redacts password= patterns in resultPreview", async () => {
      await afterToolCallHandler(
        { toolName: "read", params: {}, result: "config password=mySuperSecret123 more", durationMs: 10 },
        defaultCtx
      );

      const resultEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_result"
      );
      expect(resultEvent![0].resultPreview).not.toContain("mySuperSecret123");
      expect(resultEvent![0].resultPreview).toContain("[REDACTED]");
    });
  });

  // -----------------------------------------------------------------------
  // Security alerts disabled
  // -----------------------------------------------------------------------
  describe("with security alerts disabled", () => {
    let handler: (event: any, ctx: any) => Promise<any>;

    beforeEach(() => {
      mockApi.registerHook.mockReset();
      mockApi.on.mockReset();
      registerSecurityHandlers(mockApi, {
        apiKey: "test",
        enableBudgetEnforcement: false,
        enableSecurityAlerts: false,
      });
      const beforeCall = mockApi.on.mock.calls.find((c: any) => c[0] === "before_tool_call");
      handler = beforeCall![1];
    });

    it("does NOT check exfiltration when security alerts off", async () => {
      await handler(
        { toolName: "read", params: { path: "/app/.env" } },
        defaultCtx
      );

      expect(mockMarkCredentialAccess).not.toHaveBeenCalled();
    });

    it("does NOT check first-time tools when security alerts off", async () => {
      mockIsKnownTool.mockReturnValue(false);
      mockGetAgentUptimeHours.mockReturnValue(48);

      await handler(
        { toolName: "mysterious_tool", params: {} },
        defaultCtx
      );

      expect(mockRecordToolSeen).not.toHaveBeenCalled();
    });

    it("still logs tool_call events", async () => {
      mockEnqueue.mockClear();
      await handler(
        { toolName: "read", params: { path: "/app/file.ts" } },
        defaultCtx
      );

      const toolCallEvent = mockEnqueue.mock.calls.find(
        (c: any) => c[0].type === "tool_call"
      );
      expect(toolCallEvent).toBeTruthy();
    });
  });
});
