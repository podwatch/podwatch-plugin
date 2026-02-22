/**
 * Tests for config monitor — diffing, snapshot, event emission.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Use shared transmitter mock (Bun runs all files in one process — mocks leak)
import { mockTransmitter, resetMockTransmitter } from "./test-helpers/mock-transmitter.js";
vi.mock("./transmitter.js", () => ({ transmitter: mockTransmitter }));
const mockEnqueue = mockTransmitter.enqueue;

import {
  deepGet,
  deepClone,
  deepEqual,
  diffValues,
  extractMonitoredConfig,
  initSnapshot,
  checkConfigChanges,
  resetSnapshot,
  getSnapshot,
  MONITORED_PATHS,
} from "./config-monitor.js";

// ---------------------------------------------------------------------------
// deepGet
// ---------------------------------------------------------------------------
describe("deepGet", () => {
  it("gets nested value by dot path", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(deepGet(obj, "a.b.c")).toBe(42);
  });

  it("gets top-level value", () => {
    expect(deepGet({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("returns undefined for missing path", () => {
    expect(deepGet({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(deepGet(null, "a.b")).toBeUndefined();
  });

  it("returns undefined when traversing through primitive", () => {
    expect(deepGet({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("gets array value", () => {
    const obj = { list: [1, 2, 3] };
    expect(deepGet(obj, "list")).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// deepClone
// ---------------------------------------------------------------------------
describe("deepClone", () => {
  it("clones primitives", () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone("hello")).toBe("hello");
    expect(deepClone(true)).toBe(true);
    expect(deepClone(null)).toBeNull();
    expect(deepClone(undefined)).toBeUndefined();
  });

  it("deep clones objects", () => {
    const obj = { a: { b: 1 } };
    const cloned = deepClone(obj) as any;
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.a).not.toBe(obj.a);
  });

  it("deep clones arrays", () => {
    const arr = [1, { x: 2 }, [3]];
    const cloned = deepClone(arr) as any;
    expect(cloned).toEqual(arr);
    expect(cloned).not.toBe(arr);
    expect(cloned[1]).not.toBe(arr[1]);
  });

  it("redacts specified keys", () => {
    const obj = { apiKey: "secret123", name: "test", nested: { apiKey: "nested-secret" } };
    const cloned = deepClone(obj, ["apiKey"]) as any;
    expect(cloned.apiKey).toBe("***");
    expect(cloned.name).toBe("test");
    expect(cloned.nested.apiKey).toBe("***");
  });

  it("does not redact null/empty values", () => {
    const obj = { apiKey: null, token: "" };
    const cloned = deepClone(obj, ["apiKey", "token"]) as any;
    expect(cloned.apiKey).toBeNull();
    expect(cloned.token).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------
describe("deepEqual", () => {
  it("equal primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
  });

  it("unequal primitives", () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
  });

  it("null/undefined equality", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(true);
    expect(deepEqual(null, 0)).toBe(false);
    expect(deepEqual(undefined, "")).toBe(false);
  });

  it("equal objects", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
  });

  it("unequal objects", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("equal arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  it("unequal arrays", () => {
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("type mismatches", () => {
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ a: 1 }, [1])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diffValues
// ---------------------------------------------------------------------------
describe("diffValues", () => {
  it("returns empty array for identical primitives", () => {
    expect(diffValues("a", "a", "field")).toEqual([]);
    expect(diffValues(42, 42, "field")).toEqual([]);
  });

  it("detects primitive change", () => {
    const changes = diffValues("old", "new", "model.primary");
    expect(changes).toEqual([
      { field: "model.primary", oldValue: "old", newValue: "new" },
    ]);
  });

  it("detects null to value change", () => {
    const changes = diffValues(null, "new", "field");
    expect(changes).toEqual([
      { field: "field", oldValue: null, newValue: "new" },
    ]);
  });

  it("detects value to null change", () => {
    const changes = diffValues("old", null, "field");
    expect(changes).toEqual([
      { field: "field", oldValue: "old", newValue: null },
    ]);
  });

  it("returns empty for both null", () => {
    expect(diffValues(null, null, "field")).toEqual([]);
    expect(diffValues(undefined, undefined, "field")).toEqual([]);
  });

  it("detects type change", () => {
    const changes = diffValues("string", 42, "field");
    expect(changes).toEqual([
      { field: "field", oldValue: "string", newValue: 42 },
    ]);
  });

  it("diffs object keys recursively", () => {
    const old = { a: 1, b: "hello" };
    const cur = { a: 2, b: "hello" };
    const changes = diffValues(old, cur, "config");
    expect(changes).toEqual([
      { field: "config.a", oldValue: 1, newValue: 2 },
    ]);
  });

  it("detects added keys", () => {
    const old = { a: 1 };
    const cur = { a: 1, b: 2 };
    const changes = diffValues(old, cur, "config");
    expect(changes).toEqual([
      { field: "config.b", oldValue: null, newValue: 2 },
    ]);
  });

  it("detects removed keys", () => {
    const old = { a: 1, b: 2 };
    const cur = { a: 1 };
    const changes = diffValues(old, cur, "config");
    expect(changes).toEqual([
      { field: "config.b", oldValue: 2, newValue: null },
    ]);
  });

  it("reports array changes as whole value", () => {
    const old = [1, 2, 3];
    const cur = [1, 2, 4];
    const changes = diffValues(old, cur, "fallbacks");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("fallbacks");
    expect(changes[0]!.oldValue).toEqual([1, 2, 3]);
    expect(changes[0]!.newValue).toEqual([1, 2, 4]);
  });

  it("returns empty for identical arrays", () => {
    expect(diffValues([1, 2], [1, 2], "arr")).toEqual([]);
  });

  it("handles deeply nested changes", () => {
    const old = { a: { b: { c: 1 } } };
    const cur = { a: { b: { c: 2 } } };
    const changes = diffValues(old, cur, "root");
    expect(changes).toEqual([
      { field: "root.a.b.c", oldValue: 1, newValue: 2 },
    ]);
  });

  it("handles multiple changes across fields", () => {
    const old = { security: "full", ask: "off" };
    const cur = { security: "allowlist", ask: "on-miss" };
    const changes = diffValues(old, cur, "tools.exec");
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.field === "tools.exec.security")).toEqual({
      field: "tools.exec.security",
      oldValue: "full",
      newValue: "allowlist",
    });
    expect(changes.find((c) => c.field === "tools.exec.ask")).toEqual({
      field: "tools.exec.ask",
      oldValue: "off",
      newValue: "on-miss",
    });
  });
});

// ---------------------------------------------------------------------------
// extractMonitoredConfig
// ---------------------------------------------------------------------------
describe("extractMonitoredConfig", () => {
  const mockConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4", fallbacks: ["google/gemini"] },
        models: { "anthropic/claude-opus-4": { alias: "opus" } },
        workspace: "/home/test",
      },
    },
    tools: {
      exec: { security: "full", ask: "off" },
      elevated: { enabled: true, allowFrom: { telegram: ["user1"] } },
    },
    models: {
      providers: {
        anthropic: { apiKey: "sk-ant-secret", baseUrl: "https://api.anthropic.com", models: ["opus"] },
      },
    },
    plugins: { entries: { podwatch: { enabled: true } } },
    session: { reset: { mode: "daily" } },
    meta: { lastTouchedAt: "2026-02-22" }, // noisy — should NOT be tracked
  };

  it("extracts all monitored sections", () => {
    const extracted = extractMonitoredConfig(mockConfig);
    expect(extracted.model).toEqual({ primary: "anthropic/claude-opus-4", fallbacks: ["google/gemini"] });
    expect(extracted.models).toEqual({ "anthropic/claude-opus-4": { alias: "opus" } });
    expect(extracted["tools.exec"]).toEqual({ security: "full", ask: "off" });
    expect(extracted["tools.elevated"]).toEqual({ enabled: true, allowFrom: { telegram: ["user1"] } });
    expect(extracted.plugins).toEqual({ entries: { podwatch: { enabled: true } } });
    expect(extracted.session).toEqual({ reset: { mode: "daily" } });
  });

  it("redacts sensitive keys in providers", () => {
    const extracted = extractMonitoredConfig(mockConfig);
    const providers = extracted.providers as any;
    expect(providers.anthropic.apiKey).toBe("***");
    expect(providers.anthropic.baseUrl).toBe("https://api.anthropic.com");
  });

  it("does NOT include non-monitored fields", () => {
    const extracted = extractMonitoredConfig(mockConfig);
    expect(extracted).not.toHaveProperty("meta");
    expect(extracted).not.toHaveProperty("workspace");
  });

  it("handles missing config sections gracefully", () => {
    const sparseConfig = { agents: { defaults: { model: { primary: "test" } } } };
    const extracted = extractMonitoredConfig(sparseConfig);
    expect(extracted.model).toEqual({ primary: "test" });
    expect(extracted["tools.exec"]).toBeUndefined();
    expect(extracted.providers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stateful config monitor (initSnapshot, checkConfigChanges)
// ---------------------------------------------------------------------------
describe("stateful config monitor", () => {
  beforeEach(() => {
    resetSnapshot();
    mockEnqueue.mockClear();
  });

  it("initSnapshot captures baseline without emitting events", () => {
    const config = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: { security: "full" }, elevated: { enabled: true } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(getSnapshot()).not.toBeNull();
  });

  it("checkConfigChanges initializes snapshot if none exists", () => {
    const config = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: { security: "full" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    const changes = checkConfigChanges(config);
    expect(changes).toEqual([]);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(getSnapshot()).not.toBeNull();
  });

  it("detects model primary change", () => {
    const config1 = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: { primary: "sonnet" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "model.primary",
      oldValue: "opus",
      newValue: "sonnet",
    });

    // Should have emitted a config_change event
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const event = mockEnqueue.mock.calls[0]![0];
    expect(event.type).toBe("config_change");
    expect(event.field).toBe("model.primary");
    expect(event.value).toBe("sonnet");
    expect(event.previousValue).toBe("opus");
  });

  it("detects exec security change", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: { security: "full", ask: "off" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: { security: "allowlist", ask: "off" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("tools.exec.security");
    expect(changes[0]!.oldValue).toBe("full");
    expect(changes[0]!.newValue).toBe("allowlist");
  });

  it("detects elevated permission change", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: { enabled: false } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: { enabled: true } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("tools.elevated.enabled");
  });

  it("detects allowFrom list change", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: { enabled: true, allowFrom: { telegram: ["user1"] } } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: { enabled: true, allowFrom: { telegram: ["user1", "user2"] } } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("tools.elevated.allowFrom.telegram");
    expect(changes[0]!.oldValue).toEqual(["user1"]);
    expect(changes[0]!.newValue).toEqual(["user1", "user2"]);
  });

  it("detects plugin enabled/disabled change", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: { entries: { whatsapp: { enabled: false } } },
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: { entries: { whatsapp: { enabled: true } } },
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("plugins.entries.whatsapp.enabled");
  });

  it("detects multiple changes across sections", () => {
    const config1 = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: { security: "full" }, elevated: { enabled: false } },
      models: { providers: {} },
      plugins: {},
      session: { reset: { mode: "daily" } },
    };
    const config2 = {
      agents: { defaults: { model: { primary: "sonnet" }, models: {} } },
      tools: { exec: { security: "allowlist" }, elevated: { enabled: true } },
      models: { providers: {} },
      plugins: {},
      session: { reset: { mode: "idle" } },
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    expect(changes).toHaveLength(4);
    expect(changes.map((c) => c.field).sort()).toEqual([
      "model.primary",
      "session.reset.mode",
      "tools.elevated.enabled",
      "tools.exec.security",
    ].sort());
  });

  it("emits one event per change", () => {
    const config1 = {
      agents: { defaults: { model: { primary: "opus", fallbacks: ["a"] }, models: {} } },
      tools: { exec: { security: "full" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: { primary: "sonnet", fallbacks: ["b"] }, models: {} } },
      tools: { exec: { security: "allowlist" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    checkConfigChanges(config2);

    // primary changed, fallbacks changed, exec.security changed = 3 events
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
  });

  it("updates snapshot after checking — no duplicate events", () => {
    const config1 = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: { primary: "sonnet" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    checkConfigChanges(config2);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    mockEnqueue.mockClear();
    // Check again with same config — no new events
    checkConfigChanges(config2);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("returns no changes when config unchanged", () => {
    const config = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: { security: "full" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config);
    const changes = checkConfigChanges(config);
    expect(changes).toEqual([]);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("redacts provider secrets in emitted events", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: { anthropic: { apiKey: "secret1", baseUrl: "url1" } } },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: { anthropic: { apiKey: "secret2", baseUrl: "url2" } } },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    // apiKey is redacted in both old and new — should show "***" → "***" (no change on apiKey)
    // Only baseUrl should change
    const baseUrlChange = changes.find((c) => c.field === "providers.anthropic.baseUrl");
    expect(baseUrlChange).toBeDefined();
    expect(baseUrlChange!.oldValue).toBe("url1");
    expect(baseUrlChange!.newValue).toBe("url2");

    // apiKey should not appear as a change (both redacted to "***")
    const apiKeyChange = changes.find((c) => c.field === "providers.anthropic.apiKey");
    expect(apiKeyChange).toBeUndefined();
  });

  it("handles section appearing from undefined", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      // tools missing entirely
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: { security: "full" } },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    const execChange = changes.find((c) => c.field === "tools.exec");
    expect(execChange).toBeDefined();
    expect(execChange!.oldValue).toBeNull();
    expect(execChange!.newValue).toEqual({ security: "full" });
  });

  it("handles section disappearing to undefined", () => {
    const config1 = {
      agents: { defaults: { model: {}, models: {} } },
      tools: { exec: { security: "full" }, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: {}, models: {} } },
      // tools removed
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    const changes = checkConfigChanges(config2);

    const execChange = changes.find((c) => c.field === "tools.exec");
    expect(execChange).toBeDefined();
    expect(execChange!.oldValue).toEqual({ security: "full" });
    expect(execChange!.newValue).toBeNull();
  });

  it("event has correct shape with params for server", () => {
    const config1 = {
      agents: { defaults: { model: { primary: "opus" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };
    const config2 = {
      agents: { defaults: { model: { primary: "sonnet" }, models: {} } },
      tools: { exec: {}, elevated: {} },
      models: { providers: {} },
      plugins: {},
      session: {},
    };

    initSnapshot(config1);
    checkConfigChanges(config2);

    const event = mockEnqueue.mock.calls[0]![0];
    expect(event).toMatchObject({
      type: "config_change",
      field: "model.primary",
      value: "sonnet",
      previousValue: "opus",
      params: {
        field: "model.primary",
        value: "sonnet",
        previousValue: "opus",
      },
    });
    expect(typeof event.ts).toBe("number");
  });
});
