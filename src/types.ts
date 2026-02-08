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

// ---------------------------------------------------------------------------
// Security types
// ---------------------------------------------------------------------------

export type RiskLevel = "SAFE" | "WARNING" | "DANGER";
