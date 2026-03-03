/**
 * Memory Watcher Tests
 *
 * Tests the diff algorithm (pure functions) and watcher helper functions.
 * Integration tests for actual fs.watch are kept minimal to avoid
 * Bun single-process globalThis.fetch contamination issues.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeUnifiedDiff,
  startMemoryWatcher,
  stopMemoryWatcher,
  buildSnapshot,
  isWatchedFile,
  countDiffChanges,
  _testGetSnapshots,
  _testGetWatcherState,
  _testSetFetch,
  _testResetFetch,
} from "./memory-watcher.js";

// ─────────────────────────────────────────────────────────────
// DIFF ALGORITHM TESTS (pure function — no mocks needed)
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

  it("handles adding at the end only", () => {
    const old = "line 1\nline 2\n";
    const cur = "line 1\nline 2\nline 3\nline 4\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("+line 3");
    expect(diff).toContain("+line 4");
    expect(diff).not.toContain("-line");
  });

  it("handles removing from the beginning", () => {
    const old = "header\nbody\nfooter\n";
    const cur = "body\nfooter\n";
    const diff = computeUnifiedDiff(old, cur, "test.md");
    expect(diff).toContain("-header");
    // No added lines (only header lines contain +)
    const contentLines = diff.split("\n").filter(l => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@"));
    const addedLines = contentLines.filter(l => l.startsWith("+"));
    expect(addedLines.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// countDiffChanges — pure function tests
// ─────────────────────────────────────────────────────────────
describe("countDiffChanges", () => {
  it("counts added and removed lines", () => {
    const diff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,4 @@
 unchanged
-removed line
+added line 1
+added line 2
 unchanged`;
    const { linesAdded, linesRemoved } = countDiffChanges(diff);
    expect(linesAdded).toBe(2);
    expect(linesRemoved).toBe(1);
  });

  it("returns zeros for empty diff", () => {
    const { linesAdded, linesRemoved } = countDiffChanges("");
    expect(linesAdded).toBe(0);
    expect(linesRemoved).toBe(0);
  });

  it("does not count --- and +++ headers", () => {
    const diff = `--- a/file.md
+++ b/file.md
@@ -1,1 +1,1 @@
-old
+new`;
    const { linesAdded, linesRemoved } = countDiffChanges(diff);
    expect(linesAdded).toBe(1);
    expect(linesRemoved).toBe(1);
  });

  it("handles only additions", () => {
    const diff = `--- a/f.md
+++ b/f.md
@@ -1,1 +1,3 @@
 existing
+new1
+new2`;
    const { linesAdded, linesRemoved } = countDiffChanges(diff);
    expect(linesAdded).toBe(2);
    expect(linesRemoved).toBe(0);
  });

  it("handles only deletions", () => {
    const diff = `--- a/f.md
+++ b/f.md
@@ -1,3 +1,1 @@
 existing
-gone1
-gone2`;
    const { linesAdded, linesRemoved } = countDiffChanges(diff);
    expect(linesAdded).toBe(0);
    expect(linesRemoved).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// isWatchedFile — pure function tests
// ─────────────────────────────────────────────────────────────
describe("isWatchedFile", () => {
  it("accepts all 8 root core files", () => {
    const coreFiles = [
      "SOUL.md", "MEMORY.md", "AGENTS.md", "HEARTBEAT.md",
      "USER.md", "IDENTITY.md", "TOOLS.md", "BOOTSTRAP.md",
    ];
    for (const f of coreFiles) {
      expect(isWatchedFile(f)).toBe(true);
    }
  });

  it("accepts memory/*.md files", () => {
    expect(isWatchedFile("memory/daily.md")).toBe(true);
    expect(isWatchedFile("memory/2026-02-26.md")).toBe(true);
    expect(isWatchedFile("memory/topic-notes.md")).toBe(true);
  });

  it("rejects non-core root .md files", () => {
    expect(isWatchedFile("RANDOM.md")).toBe(false);
    expect(isWatchedFile("README.md")).toBe(false);
    expect(isWatchedFile("CHANGELOG.md")).toBe(false);
  });

  it("rejects non-.md files", () => {
    expect(isWatchedFile("notes.txt")).toBe(false);
    expect(isWatchedFile("data.json")).toBe(false);
    expect(isWatchedFile("script.sh")).toBe(false);
  });

  it("rejects memory/ non-.md files", () => {
    expect(isWatchedFile("memory/data.json")).toBe(false);
    expect(isWatchedFile("memory/notes.txt")).toBe(false);
  });

  it("rejects nested memory subdirectories", () => {
    expect(isWatchedFile("memory/sub/deep.md")).toBe(false);
    expect(isWatchedFile("memory/archive/old.md")).toBe(false);
  });

  it("rejects other directories", () => {
    expect(isWatchedFile("skills/SKILL.md")).toBe(false);
    expect(isWatchedFile("src/index.md")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// buildSnapshot — pure function tests
// ─────────────────────────────────────────────────────────────
describe("buildSnapshot", () => {
  it("builds a create snapshot for new file", () => {
    const snap = buildSnapshot("SOUL.md", null, "Hello world\nLine 2\n");
    expect(snap.filePath).toBe("SOUL.md");
    expect(snap.changeType).toBe("create");
    expect(snap.content).toBe("Hello world\nLine 2\n");
    expect(snap.diff).toContain("+Hello world");
    expect(snap.sizeBytes).toBe(Buffer.byteLength("Hello world\nLine 2\n"));
    expect(snap.lineCount).toBe(2);
    expect(snap.linesAdded).toBe(2);
    expect(snap.linesRemoved).toBe(0);
    expect(snap.timestamp).toBeTruthy();
  });

  it("builds a delete snapshot", () => {
    const snap = buildSnapshot("SOUL.md", "old content\n", null);
    expect(snap.changeType).toBe("delete");
    expect(snap.content).toBe("");
    expect(snap.sizeBytes).toBe(0);
    expect(snap.lineCount).toBe(0);
    expect(snap.linesRemoved).toBe(1);
  });

  it("builds a modify snapshot with diff", () => {
    const old = "line 1\nline 2\n";
    const cur = "line 1\nchanged\nline 3\n";
    const snap = buildSnapshot("MEMORY.md", old, cur);
    expect(snap.changeType).toBe("modify");
    expect(snap.content).toBe(cur);
    expect(snap.diff).toContain("-line 2");
    expect(snap.diff).toContain("+changed");
    expect(snap.diff).toContain("+line 3");
    expect(snap.linesAdded).toBe(2);
    expect(snap.linesRemoved).toBe(1);
  });

  it("returns null when content unchanged", () => {
    const content = "same\n";
    const snap = buildSnapshot("SOUL.md", content, content);
    expect(snap).toBeNull();
  });

  it("truncates diff exceeding 50KB", () => {
    const oldLines = Array.from({ length: 2000 }, (_, i) => `old ${i} ${"x".repeat(30)}`);
    const newLines = Array.from({ length: 2000 }, (_, i) => `new ${i} ${"y".repeat(30)}`);
    const snap = buildSnapshot("BIG.md", oldLines.join("\n"), newLines.join("\n"));
    expect(snap).not.toBeNull();
    if (snap && snap.diff.length > 50 * 1024 - 100) {
      expect(snap.diff).toContain("[diff truncated]");
    }
  });

  it("counts line count correctly for content with blank lines", () => {
    const snap = buildSnapshot("SOUL.md", null, "a\n\nb\n\nc\n");
    expect(snap).not.toBeNull();
    // lineCount counts non-empty lines
    expect(snap!.lineCount).toBe(3);
  });

  it("handles memory/ path files", () => {
    const snap = buildSnapshot("memory/daily.md", null, "daily log");
    expect(snap!.filePath).toBe("memory/daily.md");
  });

  it("sets ISO timestamp", () => {
    const snap = buildSnapshot("SOUL.md", null, "content");
    expect(snap!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─────────────────────────────────────────────────────────────
// WATCHER INTEGRATION — minimal smoke tests
// (Kept lightweight to avoid Bun single-process contamination)
// ─────────────────────────────────────────────────────────────
describe("Memory Watcher integration", () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "podwatch-memwatch-"));
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    _testSetFetch(fetchSpy as any);
  });

  afterEach(() => {
    stopMemoryWatcher();
    _testResetFetch();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("initializes file snapshots for existing core files", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul content");
    writeFileSync(join(tmpDir, "MEMORY.md"), "memory content");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 150));

    const snapshots = _testGetSnapshots();
    expect(snapshots.has("SOUL.md")).toBe(true);
    expect(snapshots.has("MEMORY.md")).toBe(true);
    expect(snapshots.get("SOUL.md")).toBe("soul content");
  });

  it("sends initial create snapshots to API", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul content");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 250));

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://test.api/api/memory/snapshot");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.filePath).toBe("SOUL.md");
    expect(body.changeType).toBe("create");
    expect(body.content).toBe("soul content");
  });

  it("watches memory/ directory .md files", async () => {
    mkdirSync(join(tmpDir, "memory"));
    writeFileSync(join(tmpDir, "memory", "daily.md"), "daily log");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 150));

    const snapshots = _testGetSnapshots();
    expect(snapshots.has("memory/daily.md")).toBe(true);
  });

  it("ignores non-core root .md files", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul");
    writeFileSync(join(tmpDir, "RANDOM.md"), "random");
    writeFileSync(join(tmpDir, "notes.txt"), "text");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 150));

    const snapshots = _testGetSnapshots();
    expect(snapshots.has("SOUL.md")).toBe(true);
    expect(snapshots.has("RANDOM.md")).toBe(false);
    expect(snapshots.has("notes.txt")).toBe(false);
  });

  it("handles missing workspace directory gracefully", () => {
    expect(() =>
      startMemoryWatcher("/nonexistent/path", "https://test.api/api", "key")
    ).not.toThrow();
  });

  it("respects 500KB file size limit", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "x".repeat(600 * 1024));
    writeFileSync(join(tmpDir, "MEMORY.md"), "small content");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 150));

    const snapshots = _testGetSnapshots();
    expect(snapshots.has("SOUL.md")).toBe(false);
    expect(snapshots.has("MEMORY.md")).toBe(true);
  });

  it("stopMemoryWatcher cleans up", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul");
    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 150));

    expect(_testGetWatcherState().isWatching).toBe(true);
    stopMemoryWatcher();
    expect(_testGetWatcherState().isWatching).toBe(false);
  });

  it("stopMemoryWatcher is safe to call multiple times", () => {
    expect(() => {
      stopMemoryWatcher();
      stopMemoryWatcher();
      stopMemoryWatcher();
    }).not.toThrow();
  });

  it("watches all 8 root core files", async () => {
    const coreFiles = [
      "SOUL.md", "MEMORY.md", "AGENTS.md", "HEARTBEAT.md",
      "USER.md", "IDENTITY.md", "TOOLS.md", "BOOTSTRAP.md",
    ];
    for (const f of coreFiles) {
      writeFileSync(join(tmpDir, f), `${f} content`);
    }
    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 250));

    const snapshots = _testGetSnapshots();
    for (const f of coreFiles) {
      expect(snapshots.has(f)).toBe(true);
    }
  });

  it("sends correct snapshot payload schema", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "line 1\nline 2\nline 3\n");
    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 250));

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);

    expect(body).toHaveProperty("filePath");
    expect(body).toHaveProperty("changeType");
    expect(body).toHaveProperty("content");
    expect(body).toHaveProperty("sizeBytes");
    expect(body).toHaveProperty("lineCount");
    expect(body).toHaveProperty("linesAdded");
    expect(body).toHaveProperty("linesRemoved");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.sizeBytes).toBe("number");
    expect(typeof body.lineCount).toBe("number");
  });

  it("sends relative file paths not absolute", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "content");
    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 250));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.filePath).toBe("SOUL.md");
    expect(body.filePath).not.toContain(tmpDir);
  });

  it("includes Authorization header", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "content");
    startMemoryWatcher(tmpDir, "https://test.api/api", "my-api-key");
    await new Promise((r) => setTimeout(r, 250));

    const opts = fetchSpy.mock.calls[0][1];
    expect(opts.headers["Authorization"]).toBe("Bearer my-api-key");
  });

  it("sends all initial snapshots concurrently", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul");
    writeFileSync(join(tmpDir, "MEMORY.md"), "memory");
    writeFileSync(join(tmpDir, "AGENTS.md"), "agents");

    startMemoryWatcher(tmpDir, "https://test.api/api", "test-key");
    await new Promise((r) => setTimeout(r, 300));

    const createCalls = fetchSpy.mock.calls.filter((c: any[]) => {
      try { return JSON.parse(c[1].body).changeType === "create"; } catch { return false; }
    });
    expect(createCalls.length).toBe(3);
  });

  it("does not throw on API failure", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    writeFileSync(join(tmpDir, "SOUL.md"), "content");
    expect(() =>
      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key")
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 250));
  });

  it("does not throw on network error", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    writeFileSync(join(tmpDir, "SOUL.md"), "content");
    expect(() =>
      startMemoryWatcher(tmpDir, "https://test.api/api", "test-key")
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 250));
  });
});
