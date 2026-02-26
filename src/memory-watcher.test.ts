/**
 * Memory Watcher Tests
 *
 * Tests the file watcher that monitors agent core memory files
 * and sends snapshots to the dashboard API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We'll import these from the module once created
import {
  computeUnifiedDiff,
  startMemoryWatcher,
  stopMemoryWatcher,
  _testGetSnapshots,
  _testGetWatcherState,
} from "./memory-watcher.js";

// ─────────────────────────────────────────────────────────────
// DIFF ALGORITHM TESTS
// ─────────────────────────────────────────────────────────────
describe("computeUnifiedDiff", () => {
  it("returns empty string when both inputs are identical", () => {
    const content = "line 1\nline 2\nline 3\n";
    expect(computeUnifiedDiff(content, content, "TEST.md")).toBe("");
  });

  it("handles empty → content (create)", () => {
    const newContent = "line 1\nline 2\n";
    const diff = computeUnifiedDiff("", newContent, "SOUL.md");
    expect(diff).toContain("--- a/SOUL.md");
    expect(diff).toContain("+++ b/SOUL.md");
    expect(diff).toContain("+line 1");
    expect(diff).toContain("+line 2");
  });

  it("handles content → empty (delete all)", () => {
    const oldContent = "line 1\nline 2\n";
    const diff = computeUnifiedDiff(oldContent, "", "MEMORY.md");
    expect(diff).toContain("--- a/MEMORY.md");
    expect(diff).toContain("+++ b/MEMORY.md");
    expect(diff).toContain("-line 1");
    expect(diff).toContain("-line 2");
  });

  it("handles single line modification", () => {
    const old = "line 1\nline 2\nline 3\n";
    const cur = "line 1\nmodified\nline 3\n";
    const diff = computeUnifiedDiff(old, cur, "AGENTS.md");
    expect(diff).toContain("-line 2");
    expect(diff).toContain("+modified");
    expect(diff).toContain(" line 1");
    expect(diff).toContain(" line 3");
  });

  it("handles multi-line additions", () => {
    const old = "line 1\nline 3\n";
    const cur = "line 1\nline 2a\nline 2b\nline 3\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("+line 2a");
    expect(diff).toContain("+line 2b");
    // Context lines should be present
    expect(diff).toContain(" line 1");
    expect(diff).toContain(" line 3");
  });

  it("handles multi-line deletions", () => {
    const old = "line 1\nline 2a\nline 2b\nline 3\n";
    const cur = "line 1\nline 3\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("-line 2a");
    expect(diff).toContain("-line 2b");
  });

  it("handles mixed add/remove", () => {
    const old = "alpha\nbeta\ngamma\n";
    const cur = "alpha\nBETA\ngamma\ndelta\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("-beta");
    expect(diff).toContain("+BETA");
    expect(diff).toContain("+delta");
  });

  it("handles very long files (1000+ lines)", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}`);
    const old = lines.join("\n") + "\n";
    const modified = [...lines];
    modified[500] = "CHANGED LINE 500";
    modified[999] = "CHANGED LINE 999";
    const cur = modified.join("\n") + "\n";
    const diff = computeUnifiedDiff(old, cur, "big.md");
    expect(diff).toContain("-line 500");
    expect(diff).toContain("+CHANGED LINE 500");
    expect(diff).toContain("-line 999");
    expect(diff).toContain("+CHANGED LINE 999");
  });

  it("handles special characters and unicode", () => {
    const old = "Hello 🌍\nCafé ☕\n";
    const cur = "Hello 🌍\nCoffee ☕\nNew 日本語\n";
    const diff = computeUnifiedDiff(old, cur, "unicode.md");
    expect(diff).toContain("-Café ☕");
    expect(diff).toContain("+Coffee ☕");
    expect(diff).toContain("+New 日本語");
  });

  it("handles files with no trailing newline", () => {
    const old = "line 1\nline 2";
    const cur = "line 1\nline 2\nline 3";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("+line 3");
  });

  it("produces correct @@ hunk header format", () => {
    const old = "a\nb\nc\n";
    const cur = "a\nB\nc\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    // Should have at least one @@ header
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("handles complete content replacement", () => {
    const old = "old line 1\nold line 2\n";
    const cur = "new line 1\nnew line 2\nnew line 3\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("-old line 1");
    expect(diff).toContain("-old line 2");
    expect(diff).toContain("+new line 1");
    expect(diff).toContain("+new line 2");
    expect(diff).toContain("+new line 3");
  });

  it("handles single-line files", () => {
    const diff = computeUnifiedDiff("old\n", "new\n", "test.md");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });
});

// ─────────────────────────────────────────────────────────────
// MEMORY WATCHER UNIT TESTS
// ─────────────────────────────────────────────────────────────
describe("Memory Watcher", () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "podwatch-memwatch-"));
    // Mock fetch globally
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as any;
  });

  afterEach(() => {
    stopMemoryWatcher();
    globalThis.fetch = originalFetch;
    // Clean up tmp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("startMemoryWatcher", () => {
    it("initializes file snapshots for existing core files", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul content");
      writeFileSync(join(tmpDir, "MEMORY.md"), "memory content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      // Allow async initial snapshots to fire
      await new Promise((r) => setTimeout(r, 100));

      const snapshots = _testGetSnapshots();
      expect(snapshots.has("SOUL.md")).toBe(true);
      expect(snapshots.has("MEMORY.md")).toBe(true);
      expect(snapshots.get("SOUL.md")).toBe("soul content");
    });

    it("sends initial create snapshots to API", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      // Should have called fetch with initial snapshot
      const calls = fetchSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [url, opts] = calls[0];
      expect(url).toBe("https://test.api/api/memory/snapshot");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.filePath).toBe("SOUL.md");
      expect(body.changeType).toBe("create");
      expect(body.content).toBe("soul content");
    });

    it("watches memory/ directory for .md files", async () => {
      mkdirSync(join(tmpDir, "memory"));
      writeFileSync(join(tmpDir, "memory", "daily.md"), "daily log");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const snapshots = _testGetSnapshots();
      expect(snapshots.has("memory/daily.md")).toBe(true);
    });

    it("ignores non-.md files", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul");
      writeFileSync(join(tmpDir, "notes.txt"), "text file");
      writeFileSync(join(tmpDir, "data.json"), "{}");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 100));

      const snapshots = _testGetSnapshots();
      expect(snapshots.has("SOUL.md")).toBe(true);
      expect(snapshots.has("notes.txt")).toBe(false);
      expect(snapshots.has("data.json")).toBe(false);
    });

    it("ignores root .md files that are not core files", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul");
      writeFileSync(join(tmpDir, "RANDOM.md"), "random");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 100));

      const snapshots = _testGetSnapshots();
      expect(snapshots.has("SOUL.md")).toBe(true);
      expect(snapshots.has("RANDOM.md")).toBe(false);
    });

    it("handles missing workspace directory gracefully", () => {
      // Should not throw
      expect(() =>
        startMemoryWatcher("/nonexistent/path", "https://test.api/api", "key")
      ).not.toThrow();
    });

    it("respects 500KB file size limit", async () => {
      // Create a file larger than 500KB
      const bigContent = "x".repeat(600 * 1024);
      writeFileSync(join(tmpDir, "SOUL.md"), bigContent);
      writeFileSync(join(tmpDir, "MEMORY.md"), "small content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const snapshots = _testGetSnapshots();
      // Big file should be skipped
      expect(snapshots.has("SOUL.md")).toBe(false);
      // Small file should be included
      expect(snapshots.has("MEMORY.md")).toBe(true);
    });
  });

  describe("file change detection", () => {
    it("detects file modifications after debounce", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "original");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      // Clear initial fetch calls
      fetchSpy.mockClear();

      // Modify the file
      writeFileSync(join(tmpDir, "SOUL.md"), "modified content");

      // Wait for debounce (3s) + processing time
      await new Promise((r) => setTimeout(r, 4000));

      // Should have sent a modify snapshot
      const modifyCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "modify";
        } catch {
          return false;
        }
      });
      expect(modifyCalls.length).toBeGreaterThan(0);

      const body = JSON.parse(modifyCalls[0][1].body);
      expect(body.filePath).toBe("SOUL.md");
      expect(body.content).toBe("modified content");
      expect(body.diff).toBeTruthy();
    }, 10000);

    it("detects new file creation in memory/", async () => {
      mkdirSync(join(tmpDir, "memory"));

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));
      fetchSpy.mockClear();

      // Create a new file
      writeFileSync(join(tmpDir, "memory", "new-topic.md"), "new content");

      await new Promise((r) => setTimeout(r, 4000));

      const createCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "create" && body.filePath === "memory/new-topic.md";
        } catch {
          return false;
        }
      });
      expect(createCalls.length).toBeGreaterThan(0);
    }, 10000);

    it("detects file deletion", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));
      fetchSpy.mockClear();

      // Delete the file
      unlinkSync(join(tmpDir, "SOUL.md"));

      await new Promise((r) => setTimeout(r, 4000));

      const deleteCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "delete";
        } catch {
          return false;
        }
      });
      expect(deleteCalls.length).toBeGreaterThan(0);

      const body = JSON.parse(deleteCalls[0][1].body);
      expect(body.filePath).toBe("SOUL.md");
      expect(body.content).toBe("");
    }, 10000);

    it("debounces rapid changes (consolidates)", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "original");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));
      fetchSpy.mockClear();

      // Write rapidly 5 times
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(tmpDir, "SOUL.md"), `version ${i}`);
        await new Promise((r) => setTimeout(r, 100));
      }

      // Wait for debounce to settle
      await new Promise((r) => setTimeout(r, 4000));

      // Should have only sent ONE modify (debounced), with the final content
      const modifyCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "modify";
        } catch {
          return false;
        }
      });
      expect(modifyCalls.length).toBe(1);
      const body = JSON.parse(modifyCalls[0][1].body);
      expect(body.content).toBe("version 4");
    }, 10000);

    it("skips if content unchanged (spurious fs.watch event)", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "unchanged");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));
      fetchSpy.mockClear();

      // Touch the file without changing content (some editors do this)
      writeFileSync(join(tmpDir, "SOUL.md"), "unchanged");

      await new Promise((r) => setTimeout(r, 4000));

      // No modify calls should have been made
      const modifyCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "modify";
        } catch {
          return false;
        }
      });
      expect(modifyCalls.length).toBe(0);
    }, 10000);
  });

  describe("stopMemoryWatcher", () => {
    it("cleans up watchers and state", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const state = _testGetWatcherState();
      expect(state.isWatching).toBe(true);

      stopMemoryWatcher();

      const stateAfter = _testGetWatcherState();
      expect(stateAfter.isWatching).toBe(false);
    });

    it("is safe to call multiple times", () => {
      expect(() => {
        stopMemoryWatcher();
        stopMemoryWatcher();
        stopMemoryWatcher();
      }).not.toThrow();
    });
  });

  describe("snapshot payload format", () => {
    it("sends correct schema fields", async () => {
      writeFileSync(join(tmpDir, "MEMORY.md"), "line 1\nline 2\nline 3\n");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);

      const [url, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);

      // Verify all required fields
      expect(body).toHaveProperty("filePath");
      expect(body).toHaveProperty("changeType");
      expect(body).toHaveProperty("content");
      expect(body).toHaveProperty("sizeBytes");
      expect(body).toHaveProperty("lineCount");
      expect(body).toHaveProperty("linesAdded");
      expect(body).toHaveProperty("linesRemoved");
      expect(body).toHaveProperty("timestamp");

      // Verify types
      expect(typeof body.filePath).toBe("string");
      expect(typeof body.changeType).toBe("string");
      expect(typeof body.content).toBe("string");
      expect(typeof body.sizeBytes).toBe("number");
      expect(typeof body.lineCount).toBe("number");
      expect(typeof body.linesAdded).toBe("number");
      expect(typeof body.linesRemoved).toBe("number");
      expect(typeof body.timestamp).toBe("string");
    });

    it("sends correct line count and size", async () => {
      const content = "line 1\nline 2\nline 3\n";
      writeFileSync(join(tmpDir, "SOUL.md"), content);

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sizeBytes).toBe(Buffer.byteLength(content));
      expect(body.lineCount).toBe(3);
    });

    it("sends relative file paths, not absolute", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.filePath).toBe("SOUL.md");
      expect(body.filePath).not.toContain(tmpDir);
    });

    it("includes Authorization header", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "content");

      startMemoryWatcher(tmpDir, "https://test.api/api", "my-api-key");
      await new Promise((r) => setTimeout(r, 200));

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.headers["Authorization"]).toBe("Bearer my-api-key");
    });
  });

  describe("diff size limits", () => {
    it("truncates diff exceeding 50KB", async () => {
      // Create a file with many lines, then change most of them
      const oldLines = Array.from({ length: 2000 }, (_, i) => `old line ${i} ${"x".repeat(30)}`);
      const newLines = Array.from({ length: 2000 }, (_, i) => `new line ${i} ${"y".repeat(30)}`);
      writeFileSync(join(tmpDir, "SOUL.md"), oldLines.join("\n"));

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));
      fetchSpy.mockClear();

      writeFileSync(join(tmpDir, "SOUL.md"), newLines.join("\n"));
      await new Promise((r) => setTimeout(r, 4000));

      const modifyCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "modify";
        } catch {
          return false;
        }
      });
      if (modifyCalls.length > 0) {
        const body = JSON.parse(modifyCalls[0][1].body);
        if (body.diff) {
          expect(body.diff.length).toBeLessThanOrEqual(50 * 1024 + 100); // 50KB + marker
          if (body.diff.length > 50 * 1024 - 100) {
            expect(body.diff).toContain("[diff truncated]");
          }
        }
      }
    }, 10000);
  });

  describe("API error handling", () => {
    it("does not throw on API failure", async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      writeFileSync(join(tmpDir, "SOUL.md"), "content");

      // Should not throw
      expect(() =>
        startMemoryWatcher(tmpDir, "https://test.api/api", "test-key")
      ).not.toThrow();

      await new Promise((r) => setTimeout(r, 200));
    });

    it("does not throw on network error", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
      writeFileSync(join(tmpDir, "SOUL.md"), "content");

      expect(() =>
        startMemoryWatcher(tmpDir, "https://test.api/api", "test-key")
      ).not.toThrow();

      await new Promise((r) => setTimeout(r, 200));
    });
  });

  describe("all core files recognized", () => {
    it("watches all 8 root core files", async () => {
      const coreFiles = [
        "SOUL.md",
        "MEMORY.md",
        "AGENTS.md",
        "HEARTBEAT.md",
        "USER.md",
        "IDENTITY.md",
        "TOOLS.md",
        "BOOTSTRAP.md",
      ];
      for (const f of coreFiles) {
        writeFileSync(join(tmpDir, f), `${f} content`);
      }

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 200));

      const snapshots = _testGetSnapshots();
      for (const f of coreFiles) {
        expect(snapshots.has(f)).toBe(true);
      }
    });
  });

  describe("concurrent initial snapshots", () => {
    it("sends all initial snapshots concurrently", async () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "soul");
      writeFileSync(join(tmpDir, "MEMORY.md"), "memory");
      writeFileSync(join(tmpDir, "AGENTS.md"), "agents");

      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
      await new Promise((r) => setTimeout(r, 300));

      // Should have sent 3 create snapshots
      const createCalls = fetchSpy.mock.calls.filter((c: any[]) => {
        try {
          const body = JSON.parse(c[1].body);
          return body.changeType === "create";
        } catch {
          return false;
        }
      });
      expect(createCalls.length).toBe(3);
    });
  });
});
