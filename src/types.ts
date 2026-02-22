/**
 * Podwatch plugin types.
 *
 * We avoid importing OpenClaw types directly to keep the plugin
 * dependency-free. Hook event shapes are inlined from plugin-sdk/index.d.ts.
 */

// ---------------------------------------------------------------------------
// Hook event types (from OpenClaw plugin-sdk)
// ---------------------------------------------------------------------------

export type PluginHookName =
  | "before_agent_start"
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "before_model_resolve"
  | "before_prompt_build"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

export interface PluginHookAgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SessionStartEvent {
  sessionId: string;
  resumedFrom?: string;
}

export interface SessionEndEvent {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
}

export interface BeforeCompactionEvent {
  messageCount: number;
  tokenCount?: number;
}

export interface GatewayStartEvent {
  port: number;
}

// ---------------------------------------------------------------------------
// Diagnostic events (from OpenClaw plugin-sdk)
// ---------------------------------------------------------------------------

export interface DiagnosticUsageEvent {
  type: "model.usage";
  ts: number;
  seq: number;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
}

export type DiagnosticEventPayload = DiagnosticUsageEvent | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Transmitter types
// ---------------------------------------------------------------------------

export interface TransmitterConfig {
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
}

export interface PodwatchEvent {
  type: string;
  ts: number;
  [key: string]: unknown;
}

// (RiskLevel removed — classification moved to server side)

// ---------------------------------------------------------------------------
// Plugin API interface (minimal typing without importing full SDK)
// ---------------------------------------------------------------------------

export interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RegisterHookOpts {
  /** Unique hook name (required). */
  name: string;
  /** Priority — lower numbers run first. Default: 100. */
  priority?: number;
}

export interface PluginApi {
  /** @deprecated Use registerHook() instead. Kept for backward compat with pre-2026.2.17 gateways. */
  on: (event: PluginHookName | string, handler: (...args: unknown[]) => void | Promise<void>) => void;
  /** Register a hook handler. `events` is a string or string[]. Requires opts.name. */
  registerHook: (
    events: PluginHookName | string | (PluginHookName | string)[],
    handler: (...args: unknown[]) => unknown | Promise<unknown>,
    opts: RegisterHookOpts,
  ) => void;
  /** Structured logger provided by the gateway. */
  logger: PluginLogger;
  /** Full gateway config (agents, diagnostics, etc.). Typed loosely for nested access. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
  /** Plugin-specific config from openclaw.json `plugins.entries.<name>.config`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pluginConfig: Record<string, any>;
  /** Plugin version string from package.json (passed by the gateway). */
  version: string;
  /** Subscribe to diagnostic events (model.usage, etc.). Returns unsubscribe fn. */
  onDiagnosticEvent?: (handler: (event: DiagnosticEventPayload) => void) => () => void;
  /** Runtime information (optional, may not be present in all gateway versions). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime?: Record<string, any>;
  /** Allow additional properties from the gateway. */
  [key: string]: unknown;
}
