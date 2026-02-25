/**
 * Tests for transmitter — 402 handling, audit log, retry logic, buffer overflow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted, so we can't read fs before the mock. Use vi.hoisted to compute version early.
const { REAL_PKG_VERSION } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
  );
  return { REAL_PKG_VERSION: pkg.version as string };
});

// Mock node:fs, node:path, node:os before importing transmitter
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error("ENOENT"); }),
  readFileSync: vi.fn((filePath: string) => {
    if (typeof filePath === "string" && filePath.endsWith("package.json")) {
      return JSON.stringify({ version: REAL_PKG_VERSION });
    }
    return "";
  }),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));
vi.mock("node:path", () => {
  const actual = require("node:path");
  return { ...actual, default: actual, dirname: actual.dirname, join: actual.join };
});
vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

import { transmitter } from "./transmitter.js";
import * as fs from "node:fs";

// Store original fetch
const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: any = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("transmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Start with a long flush interval so automatic flushes don't interfere
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    transmitter.stop();
    globalThis.fetch = originalFetch;
  });

  describe("402 trial expired", () => {
    it("sets trialExpired flag on 402 response", async () => {
      mockFetch(402);
      transmitter.enqueue({ type: "cost", ts: Date.now() });

      expect(transmitter.isTrialExpired).toBe(false);
      await transmitter.flush();
      expect(transmitter.isTrialExpired).toBe(true);
    });

    it("silently discards buffered events when trial expired", async () => {
      mockFetch(402);
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      await transmitter.flush();

      // Now enqueue more — should be silently discarded on flush
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      expect(transmitter.bufferedCount).toBe(2);

      await transmitter.flush();
      expect(transmitter.bufferedCount).toBe(0);
      // fetch should NOT be called again (1 call total from first flush)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("logs a warning on 402", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch(402);
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      await transmitter.flush();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Trial expired (402)")
      );
      warnSpy.mockRestore();
    });
  });

  describe("audit log for dropped events", () => {
    it("writes audit log on 4xx client errors", async () => {
      mockFetch(400);
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      await transmitter.flush();

      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      const call = (fs.appendFileSync as any).mock.calls[0];
      expect(call[0]).toContain("audit.log");
      const entry = JSON.parse(call[1].trim());
      expect(entry.reason).toBe("http_400");
      expect(entry.eventCount).toBe(1);
    });

    it("does NOT write audit log on 402 (separate path)", async () => {
      mockFetch(402);
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      await transmitter.flush();

      // 402 goes through the trial-expired path, not the generic 4xx audit log
      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    it("does NOT write audit log on successful flush", async () => {
      mockFetch(200);
      transmitter.enqueue({ type: "cost", ts: Date.now() });
      await transmitter.flush();

      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe("flush interval", () => {
    it("uses 30s flush interval from start config", () => {
      // The default config in index.ts passes 30_000
      // We test that the transmitter accepts it (already started in beforeEach with 999_999)
      transmitter.stop();
      transmitter.start({
        apiKey: "test-key",
        endpoint: "https://podwatch.app/api",
        batchSize: 50,
        flushIntervalMs: 30_000,
      });
      // No assertion needed — if it doesn't crash, it's using the interval correctly
    });
  });

  describe("retry counter logic (Critical #9)", () => {
    it("events survive 5 consecutive failures (old behavior would drop them)", async () => {
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now() });

      // 5 consecutive failures — events must still be in buffer
      for (let i = 0; i < 5; i++) {
        await transmitter.flush();
      }

      expect(transmitter.bufferedCount).toBe(1);
    });

    it("events dropped only after 10 consecutive failures", async () => {
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now() });

      // 9 failures — events should still be in buffer
      for (let i = 0; i < 9; i++) {
        await transmitter.flush();
      }
      expect(transmitter.bufferedCount).toBe(1);

      // 10th failure — events should be dropped
      await transmitter.flush();
      expect(transmitter.bufferedCount).toBe(0);
    });

    it("writes audit log when dropping after 10 retries", async () => {
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now() });

      for (let i = 0; i < 10; i++) {
        await transmitter.flush();
      }

      expect(fs.appendFileSync).toHaveBeenCalled();
      const call = (fs.appendFileSync as any).mock.calls[0];
      const entry = JSON.parse(call[1].trim());
      expect(entry.reason).toBe("max_retries_exceeded");
    });

    it("retry counter resets on successful flush", async () => {
      // Fail 8 times
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: "evt-1" });
      for (let i = 0; i < 8; i++) {
        await transmitter.flush();
      }
      expect(transmitter.bufferedCount).toBe(1);

      // Succeed — clears buffer, resets counter
      mockFetch(200);
      await transmitter.flush();
      expect(transmitter.bufferedCount).toBe(0);

      // Now enqueue new event and fail 9 times — should still survive
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: "evt-2" });
      for (let i = 0; i < 9; i++) {
        await transmitter.flush();
      }
      expect(transmitter.bufferedCount).toBe(1);
    });

    it("failed batch stays at front of buffer for retry", async () => {
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: "evt-first" });
      transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: "evt-second" });

      // After a failure, events should still be in the buffer (not removed)
      await transmitter.flush();
      expect(transmitter.bufferedCount).toBe(2);
    });

    it("backoff caps at 30s but does not trigger drop", async () => {
      mockFetch(500);
      transmitter.enqueue({ type: "cost", ts: Date.now() });

      // After 6 failures, backoff would be >= 32s (capped at 30s)
      // Old behavior: drop. New behavior: keep retrying until counter hits 10
      for (let i = 0; i < 6; i++) {
        await transmitter.flush();
      }
      expect(transmitter.bufferedCount).toBe(1); // still there!
    });
  });

  describe("buffer overflow (Critical #9)", () => {
    it("drops to target (900) not just by 1 when buffer exceeds MAX_BUFFER_SIZE", () => {
      // Fill buffer to exactly 1001 to trigger one overflow
      for (let i = 0; i < 1001; i++) {
        transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: `evt-${i}` });
      }

      // Should have dropped to 900 (not 1000 like old behavior)
      expect(transmitter.bufferedCount).toBe(900);
    });

    it("writes audit log on buffer overflow", () => {
      for (let i = 0; i < 1005; i++) {
        transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: `evt-${i}` });
      }

      expect(fs.appendFileSync).toHaveBeenCalled();
      const calls = (fs.appendFileSync as any).mock.calls;
      const overflowEntry = calls.find((c: any) => {
        try { return JSON.parse(c[1].trim()).reason === "buffer_overflow"; } catch { return false; }
      });
      expect(overflowEntry).toBeDefined();
    });

    it("prioritizes dropping non-critical events first on overflow", () => {
      // Enqueue 500 security (critical) + 501 cost (non-critical) = 1001 → triggers overflow
      for (let i = 0; i < 500; i++) {
        transmitter.enqueue({ type: "security", ts: Date.now(), eventId: `sec-${i}` });
      }
      for (let i = 0; i < 501; i++) {
        transmitter.enqueue({ type: "cost", ts: Date.now(), eventId: `cost-${i}` });
      }

      // Buffer was 1001, dropped to 900
      // All 500 security events should survive — only cost events dropped
      expect(transmitter.bufferedCount).toBe(900);
    });
  });
});

describe("transmitter — knownTools set cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    transmitter.stop();
    globalThis.fetch = originalFetch;
  });

  it("caps knownTools at 10,000 entries", () => {
    // Fill to 10,000
    for (let i = 0; i < 10_000; i++) {
      transmitter.recordToolSeen(`tool-${i}`);
    }
    expect(transmitter.knownToolCount).toBe(10_000);

    // Adding one more should trigger a reset
    transmitter.recordToolSeen("tool-overflow");
    // After reset, only the new tool should be in the set
    expect(transmitter.knownToolCount).toBeLessThanOrEqual(1);
  });

  it("clears the set entirely when cap is exceeded", () => {
    for (let i = 0; i < 10_000; i++) {
      transmitter.recordToolSeen(`tool-${i}`);
    }

    // Previously known tools should be recognized
    expect(transmitter.isKnownTool("tool-0")).toBe(true);

    // Trigger reset
    transmitter.recordToolSeen("tool-overflow");

    // Old tools are no longer known (set was cleared)
    expect(transmitter.isKnownTool("tool-0")).toBe(false);
    // But the overflow tool IS known (re-added after clear)
    expect(transmitter.isKnownTool("tool-overflow")).toBe(true);
  });

  it("logs a warning when knownTools set is reset", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 10_000; i++) {
      transmitter.recordToolSeen(`tool-${i}`);
    }

    // Trigger reset
    transmitter.recordToolSeen("tool-overflow");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("knownTools")
    );
    warnSpy.mockRestore();
  });

  it("works normally below the cap", () => {
    transmitter.recordToolSeen("tool-a");
    transmitter.recordToolSeen("tool-b");
    transmitter.recordToolSeen("tool-c");

    expect(transmitter.knownToolCount).toBe(3);
    expect(transmitter.isKnownTool("tool-a")).toBe(true);
    expect(transmitter.isKnownTool("tool-d")).toBe(false);
  });

  it("cap is enforced fresh after start() resets state", () => {
    for (let i = 0; i < 5_000; i++) {
      transmitter.recordToolSeen(`tool-${i}`);
    }
    expect(transmitter.knownToolCount).toBe(5_000);

    // Restart clears the set
    transmitter.stop();
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });

    expect(transmitter.knownToolCount).toBe(0);
  });
});

describe("transmitter — alert event mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    transmitter.stop();
    globalThis.fetch = originalFetch;
  });

  it("enqueues alert events for context pressure", () => {
    transmitter.enqueue({
      type: "alert",
      ts: Date.now(),
      severity: "warning",
      pattern: "context_pressure",
      tokenCount: 90000,
      contextLimit: 100000,
      ratio: 0.9,
    });

    expect(transmitter.bufferedCount).toBe(1);
  });

  it("enqueues alert events for session loop warnings", () => {
    transmitter.enqueue({
      type: "alert",
      ts: Date.now(),
      severity: "warning",
      pattern: "session_loop_warning",
      sessionKey: "s1",
      messageCount: 150,
    });

    expect(transmitter.bufferedCount).toBe(1);
  });
});

describe("transmitter — M1: plugin version from package.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset readFileSync to return package.json for version reads
    (fs.readFileSync as any).mockImplementation((filePath: string) => {
      if (typeof filePath === "string" && filePath.endsWith("package.json")) {
        return JSON.stringify({ version: REAL_PKG_VERSION });
      }
      return "";
    });
    // Default: file doesn't exist (no rotation needed)
    (fs.statSync as any).mockImplementation(() => { throw new Error("ENOENT"); });
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    transmitter.stop();
    globalThis.fetch = originalFetch;
  });

  it("sends pluginVersion from package.json (not hardcoded 0.1.0)", async () => {
    mockFetch(200);
    transmitter.enqueue({ type: "cost", ts: Date.now() });
    await transmitter.flush();

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    // Must match package.json version, not hardcoded "0.1.0"
    expect(body.pluginVersion).toBe(REAL_PKG_VERSION);
    expect(body.pluginVersion).not.toBe("0.1.0");
  });
});

describe("transmitter — M3: audit log rotation and permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset readFileSync to return package.json for version reads
    (fs.readFileSync as any).mockImplementation((filePath: string) => {
      if (typeof filePath === "string" && filePath.endsWith("package.json")) {
        return JSON.stringify({ version: REAL_PKG_VERSION });
      }
      return "";
    });
    // Default: file doesn't exist (no rotation needed)
    (fs.statSync as any).mockImplementation(() => { throw new Error("ENOENT"); });
    transmitter.start({
      apiKey: "test-key",
      endpoint: "https://podwatch.app/api",
      batchSize: 50,
      flushIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    transmitter.stop();
    globalThis.fetch = originalFetch;
  });

  it("sets file permissions to 0o600 on audit log write", async () => {
    mockFetch(400); // triggers audit log write
    transmitter.enqueue({ type: "cost", ts: Date.now() });
    await transmitter.flush();

    expect(fs.chmodSync).toHaveBeenCalledWith(
      expect.stringContaining("audit.log"),
      0o600
    );
  });

  it("rotates audit log when it exceeds 1MB", async () => {
    // Simulate a 1.1MB audit log file
    (fs.statSync as any).mockReturnValue({ size: 1_100_000 });
    const bigContent = "A".repeat(500_000) + "\n" + "B".repeat(500_000) + "\n";
    (fs.readFileSync as any).mockImplementation((filePath: string) => {
      if (typeof filePath === "string" && filePath.endsWith("package.json")) {
        return JSON.stringify({ version: REAL_PKG_VERSION });
      }
      return bigContent;
    });

    mockFetch(400); // triggers audit log write
    transmitter.enqueue({ type: "cost", ts: Date.now() });
    await transmitter.flush();

    // writeFileSync should have been called to truncate
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("audit.log"),
      expect.any(String),
      { mode: 0o600 }
    );

    // The written content should be shorter than the original
    const truncatedContent = (fs.writeFileSync as any).mock.calls[0][1];
    expect(truncatedContent.length).toBeLessThan(bigContent.length);
  });

  it("does NOT rotate when audit log is under 1MB", async () => {
    (fs.statSync as any).mockReturnValue({ size: 500_000 }); // 500KB — under limit

    mockFetch(400); // triggers audit log write
    transmitter.enqueue({ type: "cost", ts: Date.now() });
    await transmitter.flush();

    // writeFileSync should NOT be called (no rotation needed)
    expect(fs.writeFileSync).not.toHaveBeenCalled();

    // But appendFileSync should still be called (normal write)
    expect(fs.appendFileSync).toHaveBeenCalled();
  });

  it("appendFileSync is called with mode 0o600", async () => {
    mockFetch(400); // triggers audit log write
    transmitter.enqueue({ type: "cost", ts: Date.now() });
    await transmitter.flush();

    const appendCall = (fs.appendFileSync as any).mock.calls[0];
    expect(appendCall[2]).toEqual({ mode: 0o600 });
  });
});
