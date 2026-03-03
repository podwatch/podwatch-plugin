/**
 * Memory Watcher — monitors agent core memory files for changes
 * and sends snapshots to the Podwatch dashboard.
 *
 * Uses Node.js built-in fs.watch (no dependencies).
 * Implements debouncing, diffing, and size limits.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

/** Core files in workspace root that we watch */
const CORE_ROOT_FILES = new Set([
  "SOUL.md",
  "MEMORY.md",
  "AGENTS.md",
  "HEARTBEAT.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
]);

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_DIFF_SIZE = 50 * 1024; // 50KB
const MAX_FILES_WATCHED = 100;
const DEBOUNCE_MS = 3000;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  filePath: string;
  changeType: "create" | "modify" | "delete";
  diff: string;
  content: string;
  sizeBytes: number;
  lineCount: number;
  linesAdded: number;
  linesRemoved: number;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────

let watchers: fs.FSWatcher[] = [];
let fileSnapshots: Map<string, string> = new Map(); // relativePath → content
let debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let currentEndpoint = "";
let currentApiKey = "";
let isActive = false;

/** Overridable fetch for testing (avoids globalThis.fetch contamination in Bun single-process). */
let _fetch: typeof fetch = globalThis.fetch;

// ─────────────────────────────────────────────────────────────
// Diff Algorithm (LCS-based unified diff)
// ─────────────────────────────────────────────────────────────

/**
 * Compute the Longest Common Subsequence table for two arrays of strings.
 * Returns a 2D table where lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // Use Uint16Array for performance on large files, fall back to regular arrays for >65535
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  return table;
}

/**
 * Backtrack through the LCS table to produce a list of edit operations.
 * Returns array of { type: 'equal' | 'delete' | 'insert', line: string, oldIdx, newIdx }
 */
interface DiffOp {
  type: "equal" | "delete" | "insert";
  line: string;
  oldIdx: number; // 1-based line number in old file (0 for inserts)
  newIdx: number; // 1-based line number in new file (0 for deletes)
}

function backtrackDiff(table: number[][], a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1], oldIdx: i, newIdx: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: "insert", line: b[j - 1], oldIdx: 0, newIdx: j });
      j--;
    } else {
      ops.push({ type: "delete", line: a[i - 1], oldIdx: i, newIdx: 0 });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Group diff operations into hunks with context lines.
 */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function buildHunks(ops: DiffOp[], contextLines: number = 3): Hunk[] {
  // Find ranges of changes
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes into hunks (merge if context overlaps)
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let k = 1; k < changeIndices.length; k++) {
    if (changeIndices[k] - groupEnd <= contextLines * 2 + 1) {
      // Close enough to merge
      groupEnd = changeIndices[k];
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = changeIndices[k];
      groupEnd = changeIndices[k];
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Build hunks
  const hunks: Hunk[] = [];
  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - contextLines);
    const hunkEnd = Math.min(ops.length - 1, group.end + contextLines);

    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    const lines: string[] = [];

    // Compute starting line numbers
    let foundStart = false;
    for (let i = hunkStart; i <= hunkEnd; i++) {
      const op = ops[i];
      if (!foundStart) {
        if (op.type === "equal") {
          oldStart = op.oldIdx;
          newStart = op.newIdx;
        } else if (op.type === "delete") {
          oldStart = op.oldIdx;
          // Find the corresponding new line number
          newStart = findNewLineAt(ops, i);
        } else {
          oldStart = findOldLineAt(ops, i);
          newStart = op.newIdx;
        }
        foundStart = true;
      }

      if (op.type === "equal") {
        lines.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.type === "delete") {
        lines.push(`-${op.line}`);
        oldCount++;
      } else {
        lines.push(`+${op.line}`);
        newCount++;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}

/** Find the new-file line number at a given ops index (for delete ops) */
function findNewLineAt(ops: DiffOp[], idx: number): number {
  // Walk backward to find the last known new index, then walk forward
  for (let i = idx - 1; i >= 0; i--) {
    if (ops[i].newIdx > 0) return ops[i].newIdx + 1;
  }
  return 1;
}

/** Find the old-file line number at a given ops index (for insert ops) */
function findOldLineAt(ops: DiffOp[], idx: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    if (ops[i].oldIdx > 0) return ops[i].oldIdx + 1;
  }
  return 1;
}

/**
 * Compute a unified diff between old and new content.
 * Returns empty string if contents are identical.
 */
export function computeUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string
): string {
  if (oldContent === newContent) return "";

  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  // Remove trailing empty line from split (artifact of trailing \n)
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();

  const table = lcsTable(oldLines, newLines);
  const ops = backtrackDiff(table, oldLines, newLines);
  const hunks = buildHunks(ops);

  if (hunks.length === 0) return "";

  const parts: string[] = [];
  parts.push(`--- a/${filePath}`);
  parts.push(`+++ b/${filePath}`);

  for (const hunk of hunks) {
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
    );
    parts.push(...hunk.lines);
  }

  return parts.join("\n");
}

/**
 * Count lines added and removed from a diff string.
 */
export function countDiffChanges(diff: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
    if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

// ─────────────────────────────────────────────────────────────
// Snapshot Sending
// ─────────────────────────────────────────────────────────────

async function sendSnapshot(
  endpoint: string,
  apiKey: string,
  snapshot: MemorySnapshot
): Promise<void> {
  try {
    const res = await _fetch(`${endpoint}/memory/snapshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) {
      console.warn(`[podwatch:memory] Failed to send snapshot: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[podwatch:memory] Failed to send snapshot:`, err);
  }
}

// ─────────────────────────────────────────────────────────────
// File Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Check if a relative path is a file we should watch.
 */
export function isWatchedFile(relativePath: string): boolean {
  // Root core files
  if (CORE_ROOT_FILES.has(relativePath)) return true;

  // memory/*.md (not recursive — must be exactly one directory deep)
  const parts = relativePath.split(path.sep);
  if (
    parts.length === 2 &&
    parts[0] === "memory" &&
    parts[1].endsWith(".md")
  ) {
    return true;
  }

  return false;
}

/**
 * Safely read a file's content, returning null on error or if too large.
 */
function safeReadFile(absolutePath: string): string | null {
  try {
    const stats = fs.statSync(absolutePath);
    if (stats.size > MAX_FILE_SIZE) {
      console.warn(
        `[podwatch:memory] Skipping ${absolutePath} — exceeds ${MAX_FILE_SIZE} byte limit (${stats.size})`
      );
      return null;
    }
    return fs.readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Scan workspace for existing watched files and populate the snapshot map.
 */
function scanExistingFiles(workspaceDir: string): void {
  // Scan root core files
  for (const fileName of CORE_ROOT_FILES) {
    const absPath = path.join(workspaceDir, fileName);
    const content = safeReadFile(absPath);
    if (content !== null && fileSnapshots.size < MAX_FILES_WATCHED) {
      fileSnapshots.set(fileName, content);
    }
  }

  // Scan memory/ directory
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
      const entries = fs.readdirSync(memoryDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        if (fileSnapshots.size >= MAX_FILES_WATCHED) break;

        const relativePath = path.join("memory", entry);
        const absPath = path.join(workspaceDir, relativePath);
        const content = safeReadFile(absPath);
        if (content !== null) {
          fileSnapshots.set(relativePath, content);
        }
      }
    }
  } catch (err) {
    console.warn("[podwatch:memory] Error scanning memory/ directory:", err);
  }
}

/**
 * Send initial snapshots for all existing files (concurrent).
 */
async function sendInitialSnapshots(
  endpoint: string,
  apiKey: string
): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const [relativePath, content] of fileSnapshots) {
    const lineCount = content ? content.split("\n").filter((l) => l !== "").length : 0;
    const snapshot: MemorySnapshot = {
      filePath: relativePath,
      changeType: "create",
      diff: "",
      content,
      sizeBytes: Buffer.byteLength(content, "utf-8"),
      lineCount,
      linesAdded: lineCount,
      linesRemoved: 0,
      timestamp: new Date().toISOString(),
    };
    promises.push(sendSnapshot(endpoint, apiKey, snapshot));
  }

  await Promise.allSettled(promises);
}

// ─────────────────────────────────────────────────────────────
// Snapshot Builder (pure function — testable without mocks)
// ─────────────────────────────────────────────────────────────

/**
 * Build a snapshot object from old and new content.
 * Returns null if content is unchanged.
 *
 * @param filePath - relative file path (e.g. "SOUL.md", "memory/daily.md")
 * @param oldContent - previous content (null = new file)
 * @param newContent - current content (null = deleted file)
 */
export function buildSnapshot(
  filePath: string,
  oldContent: string | null,
  newContent: string | null
): MemorySnapshot | null {
  // Delete
  if (newContent === null) {
    const oldLineCount = oldContent ? oldContent.split("\n").filter((l) => l !== "").length : 0;
    return {
      filePath,
      changeType: "delete",
      diff: "",
      content: "",
      sizeBytes: 0,
      lineCount: 0,
      linesAdded: 0,
      linesRemoved: oldLineCount,
      timestamp: new Date().toISOString(),
    };
  }

  // Create — generate a full-add diff so the UI can display it
  if (oldContent === null) {
    const lineCount = newContent.split("\n").filter((l) => l !== "").length;
    const lines = newContent.split("\n");
    const createDiff = `--- /dev/null\n+++ ${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
    const clampedDiff = createDiff.length > MAX_DIFF_SIZE ? createDiff.slice(0, MAX_DIFF_SIZE) + "\n[diff truncated]" : createDiff;
    return {
      filePath,
      changeType: "create",
      diff: clampedDiff,
      content: newContent,
      sizeBytes: Buffer.byteLength(newContent, "utf-8"),
      lineCount,
      linesAdded: lineCount,
      linesRemoved: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // Unchanged
  if (oldContent === newContent) return null;

  // Modify
  let diff = computeUnifiedDiff(oldContent, newContent, filePath);
  if (diff.length > MAX_DIFF_SIZE) {
    diff = diff.slice(0, MAX_DIFF_SIZE) + "\n[diff truncated]";
  }

  const { linesAdded, linesRemoved } = countDiffChanges(diff);
  const lineCount = newContent.split("\n").filter((l) => l !== "").length;

  return {
    filePath,
    changeType: "modify",
    diff,
    content: newContent,
    sizeBytes: Buffer.byteLength(newContent, "utf-8"),
    lineCount,
    linesAdded,
    linesRemoved,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// File Change Handling
// ─────────────────────────────────────────────────────────────

/**
 * Handle a file change event (called after debounce).
 */
async function handleFileChange(
  workspaceDir: string,
  relativePath: string
): Promise<void> {
  const absPath = path.join(workspaceDir, relativePath);
  const exists = fs.existsSync(absPath);
  const previousContent = fileSnapshots.get(relativePath);
  const wasKnown = fileSnapshots.has(relativePath);

  if (!exists) {
    // File was deleted
    if (wasKnown) {
      fileSnapshots.delete(relativePath);
      const snapshot: MemorySnapshot = {
        filePath: relativePath,
        changeType: "delete",
        diff: "",
        content: "",
        sizeBytes: 0,
        lineCount: 0,
        linesAdded: 0,
        linesRemoved: previousContent
          ? previousContent.split("\n").filter((l) => l !== "").length
          : 0,
        timestamp: new Date().toISOString(),
      };
      await sendSnapshot(currentEndpoint, currentApiKey, snapshot);
    }
    return;
  }

  // File exists — read content
  const content = safeReadFile(absPath);
  if (content === null) return;

  // Check if this is a watched file (for memory/ new files)
  if (!isWatchedFile(relativePath)) return;

  if (!wasKnown) {
    // New file created
    if (fileSnapshots.size >= MAX_FILES_WATCHED) return;
    fileSnapshots.set(relativePath, content);
    const lineCount = content.split("\n").filter((l) => l !== "").length;
    const snapshot: MemorySnapshot = {
      filePath: relativePath,
      changeType: "create",
      diff: "",
      content,
      sizeBytes: Buffer.byteLength(content, "utf-8"),
      lineCount,
      linesAdded: lineCount,
      linesRemoved: 0,
      timestamp: new Date().toISOString(),
    };
    await sendSnapshot(currentEndpoint, currentApiKey, snapshot);
    return;
  }

  // Modified file — check if content actually changed
  if (content === previousContent) return; // Spurious event

  let diff = computeUnifiedDiff(previousContent ?? "", content, relativePath);

  // Truncate diff if too large
  if (diff.length > MAX_DIFF_SIZE) {
    diff = diff.slice(0, MAX_DIFF_SIZE) + "\n[diff truncated]";
  }

  const { linesAdded, linesRemoved } = countDiffChanges(diff);
  const lineCount = content.split("\n").filter((l) => l !== "").length;

  fileSnapshots.set(relativePath, content);

  const snapshot: MemorySnapshot = {
    filePath: relativePath,
    changeType: "modify",
    diff,
    content,
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    lineCount,
    linesAdded,
    linesRemoved,
    timestamp: new Date().toISOString(),
  };

  await sendSnapshot(currentEndpoint, currentApiKey, snapshot);
}

/**
 * Debounced file change handler.
 * Resets the timer each time the same file changes within DEBOUNCE_MS.
 */
function onFileEvent(
  workspaceDir: string,
  relativePath: string
): void {
  // Clear existing timer for this file
  const existing = debounceTimers.get(relativePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(relativePath);
    void handleFileChange(workspaceDir, relativePath);
  }, DEBOUNCE_MS);

  // Unref so timer doesn't prevent process exit
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  debounceTimers.set(relativePath, timer);
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Start watching core memory files in the workspace.
 * Sends initial snapshots and sets up fs watchers.
 */
export function startMemoryWatcher(
  workspaceDir: string,
  apiEndpoint: string,
  apiKey: string
): void {
  // Stop any existing watcher first
  stopMemoryWatcher();

  currentEndpoint = apiEndpoint;
  currentApiKey = apiKey;
  isActive = true;

  // Validate workspace
  try {
    if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
      console.warn(`[podwatch:memory] Workspace directory does not exist: ${workspaceDir}`);
      return;
    }
  } catch (err) {
    console.warn(`[podwatch:memory] Error checking workspace: ${err}`);
    return;
  }

  // Scan existing files
  scanExistingFiles(workspaceDir);

  // Send initial snapshots (fire-and-forget)
  void sendInitialSnapshots(apiEndpoint, apiKey);

  // Set up watchers
  try {
    // Watch workspace root for core files
    const rootWatcher = fs.watch(workspaceDir, (eventType, filename) => {
      if (!filename || !isActive) return;
      if (!CORE_ROOT_FILES.has(filename)) return;
      onFileEvent(workspaceDir, filename);
    });
    rootWatcher.on("error", (err) => {
      console.warn("[podwatch:memory] Root watcher error:", err);
    });
    watchers.push(rootWatcher);

    // Watch memory/ directory for .md files
    const memoryDir = path.join(workspaceDir, "memory");
    if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
      const memWatcher = fs.watch(memoryDir, (eventType, filename) => {
        if (!filename || !isActive) return;
        if (!filename.endsWith(".md")) return;
        const relativePath = path.join("memory", filename);
        onFileEvent(workspaceDir, relativePath);
      });
      memWatcher.on("error", (err) => {
        console.warn("[podwatch:memory] Memory dir watcher error:", err);
      });
      watchers.push(memWatcher);
    }
  } catch (err) {
    console.warn("[podwatch:memory] Error setting up watchers:", err);
    // Try once more with a delay
    setTimeout(() => {
      try {
        if (!isActive) return;
        const rootWatcher = fs.watch(workspaceDir, (eventType, filename) => {
          if (!filename || !isActive) return;
          if (!CORE_ROOT_FILES.has(filename)) return;
          onFileEvent(workspaceDir, filename);
        });
        watchers.push(rootWatcher);
      } catch {
        console.warn("[podwatch:memory] Watcher retry failed, giving up");
      }
    }, 5000);
  }

  console.log(
    `[podwatch:memory] Watching ${fileSnapshots.size} files in ${workspaceDir}`
  );
}

/**
 * Stop watching files and clean up all state.
 */
export function stopMemoryWatcher(): void {
  isActive = false;

  // Close all watchers
  for (const w of watchers) {
    try {
      w.close();
    } catch {}
  }
  watchers = [];

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  // Clear snapshots
  fileSnapshots.clear();

  currentEndpoint = "";
  currentApiKey = "";
}

// ─────────────────────────────────────────────────────────────
// Test Helpers (exported for testing only)
// ─────────────────────────────────────────────────────────────

/** @internal — for tests only: override the fetch function */
export function _testSetFetch(fn: typeof fetch): void {
  _fetch = fn;
}

/** @internal — for tests only: restore the default fetch */
export function _testResetFetch(): void {
  _fetch = globalThis.fetch;
}

/** @internal — for tests only */
export function _testGetSnapshots(): Map<string, string> {
  return new Map(fileSnapshots);
}

/** @internal — for tests only */
export function _testGetWatcherState(): {
  isWatching: boolean;
  watcherCount: number;
  snapshotCount: number;
} {
  return {
    isWatching: isActive && watchers.length > 0,
    watcherCount: watchers.length,
    snapshotCount: fileSnapshots.size,
  };
}
