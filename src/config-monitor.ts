/**
 * Config monitor — snapshots and diffs the gateway config for drift/tampering detection.
 *
 * Monitors security-relevant config fields and emits config_change events
 * when drift is detected. Called on startup, every pulse, and gateway_start.
 *
 * Replaces the single-field model tracking that was in lifecycle.ts.
 */

import { transmitter } from "./transmitter.js";

// ---------------------------------------------------------------------------
// Monitored config paths
// ---------------------------------------------------------------------------

export interface MonitoredPath {
  /** Dot-separated path into api.config (e.g. "agents.defaults.model") */
  path: string;
  /** Human-readable label used as prefix in change events */
  label: string;
  /** Keys to redact from snapshots (e.g. apiKey) — prevents secrets in events */
  redactKeys?: string[];
}

export const MONITORED_PATHS: MonitoredPath[] = [
  { path: "agents.defaults.model", label: "model" },
  { path: "agents.defaults.models", label: "models" },
  { path: "tools.exec", label: "tools.exec" },
  { path: "tools.elevated", label: "tools.elevated" },
  { path: "models.providers", label: "providers", redactKeys: ["apiKey", "apiSecret", "secret", "token"] },
  { path: "plugins", label: "plugins" },
  { path: "session", label: "session" },
];

// ---------------------------------------------------------------------------
// Pure utility functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Get a nested value from an object by dot-separated path.
 */
export function deepGet(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Deep clone a value, replacing values at sensitive keys with "***".
 */
export function deepClone(value: unknown, redactKeys?: string[]): unknown {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => deepClone(v, redactKeys));

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (redactKeys?.includes(k) && v != null && v !== "") {
      result[k] = "***";
    } else {
      result[k] = deepClone(v, redactKeys);
    }
  }
  return result;
}

/**
 * Deep equality check for two values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    return a.every((v, i) => deepEqual(v, arrB[i]));
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();

  if (keysA.length !== keysB.length) return false;
  if (!keysA.every((k, i) => k === keysB[i])) return false;
  return keysA.every((k) => deepEqual(objA[k], objB[k]));
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface ConfigChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Diff two values recursively. Returns a list of changes with dot-path field names.
 * For arrays, reports the whole array as changed (no element-level diff).
 */
export function diffValues(oldVal: unknown, newVal: unknown, prefix: string): ConfigChange[] {
  const changes: ConfigChange[] = [];

  // Both null/undefined — no change
  if (oldVal == null && newVal == null) return changes;

  // One is null/undefined — whole path changed
  if (oldVal == null || newVal == null) {
    changes.push({ field: prefix, oldValue: oldVal ?? null, newValue: newVal ?? null });
    return changes;
  }

  // Different types
  if (typeof oldVal !== typeof newVal) {
    changes.push({ field: prefix, oldValue: oldVal, newValue: newVal });
    return changes;
  }

  // Primitives
  if (typeof oldVal !== "object") {
    if (oldVal !== newVal) {
      changes.push({ field: prefix, oldValue: oldVal, newValue: newVal });
    }
    return changes;
  }

  // Arrays — report as whole if different
  if (Array.isArray(oldVal) || Array.isArray(newVal)) {
    if (!deepEqual(oldVal, newVal)) {
      changes.push({ field: prefix, oldValue: oldVal, newValue: newVal });
    }
    return changes;
  }

  // Objects — recurse into each key
  const oldRecord = oldVal as Record<string, unknown>;
  const newRecord = newVal as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)]);

  for (const key of allKeys) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    changes.push(...diffValues(oldRecord[key], newRecord[key], childPath));
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Snapshot extraction
// ---------------------------------------------------------------------------

/**
 * Extract monitored config sections from the full gateway config.
 * Redacts sensitive keys (apiKey, etc.) so they don't appear in events.
 */
export function extractMonitoredConfig(
  config: Record<string, unknown>,
  paths: MonitoredPath[] = MONITORED_PATHS,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { path, label, redactKeys } of paths) {
    const value = deepGet(config, path);
    result[label] = deepClone(value, redactKeys);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stateful config monitor
// ---------------------------------------------------------------------------

let snapshot: Record<string, unknown> | null = null;

/**
 * Initialize the config snapshot. Called once on register().
 * Does NOT emit events (baseline capture).
 */
export function initSnapshot(config: Record<string, unknown>): void {
  snapshot = extractMonitoredConfig(config);
}

/**
 * Check for config changes against the stored snapshot.
 * Emits config_change events for each changed field, then updates snapshot.
 *
 * If no snapshot exists yet, initializes one (no events emitted).
 */
export function checkConfigChanges(config: Record<string, unknown>): ConfigChange[] {
  if (!snapshot) {
    initSnapshot(config);
    return [];
  }

  const current = extractMonitoredConfig(config);
  const allChanges: ConfigChange[] = [];

  for (const { label } of MONITORED_PATHS) {
    const changes = diffValues(snapshot[label], current[label], label);
    for (const change of changes) {
      allChanges.push(change);
      transmitter.enqueue({
        type: "config_change",
        ts: Date.now(),
        field: change.field,
        value: change.newValue,
        previousValue: change.oldValue,
        params: {
          field: change.field,
          value: change.newValue,
          previousValue: change.oldValue,
        },
      });
    }
  }

  // Update snapshot after emitting
  snapshot = current;

  return allChanges;
}

/**
 * Reset the snapshot (for testing or re-register).
 */
export function resetSnapshot(): void {
  snapshot = null;
}

/**
 * Get the current snapshot (for testing/diagnostics).
 */
export function getSnapshot(): Record<string, unknown> | null {
  return snapshot ? { ...snapshot } : null;
}
