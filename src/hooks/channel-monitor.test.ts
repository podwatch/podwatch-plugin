/**
 * Tests for channel connectivity monitor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeChannelHealth,
  buildChannelHealthList,
  _resetChannelMonitorState,
  startChannelMonitor,
  stopChannelMonitor,
  type ChannelHealth,
} from "./channel-monitor.js";

// ---------------------------------------------------------------------------
// Mock child_process (execFile) and fetch
// ---------------------------------------------------------------------------

const { mockExecFile, mockFetch } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", () => ({
  promisify: (fn: any) => (...args: any[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  },
}));

globalThis.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGatewayResponse(overrides: Record<string, any> = {}) {
  return {
    ts: Date.now(),
    channelOrder: ["telegram"],
    channelLabels: { telegram: "Telegram" },
    channels: {
      telegram: {
        configured: true,
        running: true,
        mode: "polling",
        lastStartAt: Date.now() - 60_000,
        lastStopAt: null,
        lastError: null,
      },
    },
    channelAccounts: {
      telegram: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          running: true,
          mode: "polling",
          lastStartAt: Date.now() - 60_000,
          lastStopAt: null,
          lastError: null,
          lastInboundAt: Date.now() - 120_000,
          lastOutboundAt: Date.now() - 60_000,
        },
      ],
    },
    channelDefaultAccountId: { telegram: "default" },
    ...overrides,
  };
}

function makeAccount(overrides: Record<string, any> = {}) {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    running: true,
    mode: "polling",
    lastStartAt: Date.now() - 60_000,
    lastStopAt: null,
    lastError: null,
    lastInboundAt: Date.now() - 120_000,
    lastOutboundAt: Date.now() - 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  _resetChannelMonitorState();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  stopChannelMonitor();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// computeChannelHealth
// ---------------------------------------------------------------------------

describe("computeChannelHealth", () => {
  const NOW = 1700000000000;

  it("returns healthy for running configured channel with recent messages", () => {
    const account = makeAccount({
      lastInboundAt: NOW - 5 * 60 * 1_000, // 5 min ago
      lastOutboundAt: NOW - 2 * 60 * 1_000, // 2 min ago
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("healthy");
    expect(result.channelId).toBe("telegram");
    expect(result.name).toBe("Telegram");
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.running).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns down when channel is disabled", () => {
    const account = makeAccount({ enabled: false });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("down");
    expect(result.warnings).toContain("Channel is disabled");
  });

  it("returns down when channel is not configured", () => {
    const account = makeAccount({ configured: false, enabled: true, running: false });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("down");
    expect(result.warnings).toContain("Channel is not configured");
  });

  it("returns down when channel is not running", () => {
    const account = makeAccount({ running: false });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("down");
    expect(result.warnings).toContain("Channel is not running");
  });

  it("returns down with error message when channel has lastError", () => {
    const account = makeAccount({ running: false, lastError: "Connection timeout" });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("down");
    expect(result.warnings).toContain("Last error: Connection timeout");
  });

  it("returns degraded when no inbound in 30+ minutes", () => {
    const account = makeAccount({
      lastInboundAt: NOW - 35 * 60 * 1_000, // 35 min ago
      lastOutboundAt: NOW - 2 * 60 * 1_000,  // 2 min ago
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("degraded");
    expect(result.warnings).toContain("No inbound messages in 30+ minutes");
  });

  it("returns degraded when no outbound in 30+ minutes", () => {
    const account = makeAccount({
      lastInboundAt: NOW - 2 * 60 * 1_000,   // 2 min ago
      lastOutboundAt: NOW - 35 * 60 * 1_000, // 35 min ago
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("degraded");
    expect(result.warnings).toContain("No outbound messages in 30+ minutes");
  });

  it("returns degraded with both warnings when both inbound and outbound stale", () => {
    const account = makeAccount({
      lastInboundAt: NOW - 40 * 60 * 1_000,
      lastOutboundAt: NOW - 40 * 60 * 1_000,
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("degraded");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain("No inbound messages in 30+ minutes");
    expect(result.warnings).toContain("No outbound messages in 30+ minutes");
  });

  it("returns healthy when running with no message history (fresh setup)", () => {
    const account = makeAccount({
      lastInboundAt: null,
      lastOutboundAt: null,
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("healthy");
    expect(result.warnings).toHaveLength(0);
  });

  it("formats timestamps as ISO strings", () => {
    const ts = 1700000000000;
    const account = makeAccount({
      lastInboundAt: ts,
      lastOutboundAt: ts,
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.lastInboundAt).toBe(new Date(ts).toISOString());
    expect(result.lastOutboundAt).toBe(new Date(ts).toISOString());
  });

  it("returns null timestamps when missing", () => {
    const account = makeAccount({
      lastInboundAt: null,
      lastOutboundAt: undefined,
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.lastInboundAt).toBeNull();
    expect(result.lastOutboundAt).toBeNull();
  });

  it("extracts mode from account", () => {
    const account = makeAccount({ mode: "webhook" });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.mode).toBe("webhook");
  });

  it("returns null mode when missing", () => {
    const account = makeAccount({ mode: undefined });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.mode).toBeNull();
  });

  it("uses defaults for missing enabled/configured fields", () => {
    const account = {
      accountId: "default",
      running: true,
    };
    const result = computeChannelHealth("telegram", "Telegram", account as any, NOW);
    // enabled defaults to true, configured defaults to false
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(false);
  });

  it("prioritizes down over degraded", () => {
    const account = makeAccount({
      running: false,
      lastInboundAt: NOW - 40 * 60 * 1_000, // stale
    });
    const result = computeChannelHealth("telegram", "Telegram", account, NOW);
    expect(result.status).toBe("down");
    // Should only have the down warning, not the degraded one
    expect(result.warnings.some((w) => w.includes("not running"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("30+ minutes"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildChannelHealthList
// ---------------------------------------------------------------------------

describe("buildChannelHealthList", () => {
  const NOW = 1700000000000;

  it("builds health list from gateway response", () => {
    const response = makeGatewayResponse();
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].channelId).toBe("telegram");
    expect(result[0].accountId).toBe("default");
    expect(result[0].name).toBe("Telegram");
  });

  it("handles multiple channels", () => {
    const response = makeGatewayResponse({
      channelOrder: ["telegram", "discord"],
      channelLabels: { telegram: "Telegram", discord: "Discord" },
      channelAccounts: {
        telegram: [makeAccount()],
        discord: [makeAccount({ accountId: "guild1" })],
      },
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].channelId).toBe("telegram");
    expect(result[1].channelId).toBe("discord");
  });

  it("handles multiple accounts per channel", () => {
    const response = makeGatewayResponse({
      channelAccounts: {
        telegram: [
          makeAccount({ accountId: "bot1" }),
          makeAccount({ accountId: "bot2", running: false }),
        ],
      },
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].accountId).toBe("bot1");
    expect(result[1].accountId).toBe("bot2");
  });

  it("returns empty for missing channelAccounts", () => {
    const response = makeGatewayResponse({ channelAccounts: undefined });
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(0);
  });

  it("skips channels with non-array accounts", () => {
    const response = makeGatewayResponse({
      channelAccounts: { telegram: "invalid" as any },
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(0);
  });

  it("uses channelId as label when no label defined", () => {
    const response = makeGatewayResponse({
      channelLabels: {},
      channelAccounts: { whatsapp: [makeAccount()] },
      channelOrder: ["whatsapp"],
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result[0].name).toBe("whatsapp");
  });

  it("falls back to channelAccounts keys when no channelOrder", () => {
    const response = makeGatewayResponse({
      channelOrder: undefined,
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result.length).toBeGreaterThan(0);
  });

  it("skips null/non-object accounts in the array", () => {
    const response = makeGatewayResponse({
      channelAccounts: {
        telegram: [null, makeAccount(), undefined] as any[],
      },
    });
    const result = buildChannelHealthList(response, NOW);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// startChannelMonitor / stopChannelMonitor
// ---------------------------------------------------------------------------

describe("startChannelMonitor", () => {
  it("starts periodic health checks", async () => {
    // Mock the CLI call
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const response = makeGatewayResponse();
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");

    // Wait for initial check
    await vi.advanceTimersByTimeAsync(100);

    // Verify fetch was called with channel health data
    expect(mockFetch).toHaveBeenCalledWith(
      "https://podwatch.app/api/channel-health",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
      }),
    );

    stopChannelMonitor();
  });

  it("sends data only on change", async () => {
    const response = makeGatewayResponse();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");

    // First check
    await vi.advanceTimersByTimeAsync(100);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance to next interval — same data, should NOT send again
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    stopChannelMonitor();
  });

  it("stops cleanly", () => {
    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    stopChannelMonitor();
    // No assertion needed — just ensure no errors
  });

  it("does not send when endpoint is not configured", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const response = makeGatewayResponse();
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });

    startChannelMonitor(300_000, undefined, undefined, undefined);

    await vi.advanceTimersByTimeAsync(100);

    // Should not attempt to send
    expect(mockFetch).not.toHaveBeenCalled();

    stopChannelMonitor();
  });

  it("handles CLI failure gracefully", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(new Error("Command not found"), "", "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");

    await vi.advanceTimersByTimeAsync(100);

    // Should not crash, should not send
    expect(mockFetch).not.toHaveBeenCalled();

    stopChannelMonitor();
  });
});

// ---------------------------------------------------------------------------
// sendChannelHealthToApi — body validation
// ---------------------------------------------------------------------------

describe("sendChannelHealthToApi body shape", () => {
  it("sends correct JSON structure", async () => {
    const NOW = Date.now();
    const response = makeGatewayResponse({
      channelAccounts: {
        telegram: [
          makeAccount({
            lastInboundAt: NOW - 5000,
            lastOutboundAt: NOW - 3000,
          }),
        ],
      },
    });

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);

    expect(body.type).toBe("channel_health");
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      channelId: "telegram",
      accountId: "default",
      name: "Telegram",
      enabled: true,
      configured: true,
      running: true,
      mode: "polling",
      status: expect.stringMatching(/^(healthy|degraded|down)$/),
    });
    expect(body.channels[0]).toHaveProperty("lastInboundAt");
    expect(body.channels[0]).toHaveProperty("lastOutboundAt");
    expect(body.channels[0]).toHaveProperty("warnings");

    stopChannelMonitor();
  });
});

// ---------------------------------------------------------------------------
// Edge cases / robustness
// ---------------------------------------------------------------------------

describe("robustness", () => {
  it("handles malformed JSON from CLI", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "Gateway call: channels.status\n{invalid json", "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
    stopChannelMonitor();
  });

  it("handles empty stdout from CLI", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
    stopChannelMonitor();
  });

  it("handles fetch failure gracefully", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const response = makeGatewayResponse();
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });
    mockFetch.mockRejectedValue(new Error("Network error"));

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    // Should not crash
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stopChannelMonitor();
  });

  it("handles API error response gracefully", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const response = makeGatewayResponse();
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    // Should not crash
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stopChannelMonitor();
  });

  it("replaces existing timer on restart", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const response = makeGatewayResponse();
      const stdout = `Gateway call: channels.status\n${JSON.stringify(response)}`;
      cb(null, stdout, "");
    });

    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    startChannelMonitor(300_000, undefined, "https://podwatch.app/api", "test-key");
    await vi.advanceTimersByTimeAsync(100);

    stopChannelMonitor();
  });
});
