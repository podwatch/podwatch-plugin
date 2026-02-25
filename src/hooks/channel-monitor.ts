/**
 * Channel connectivity monitor — queries the local gateway for channel
 * runtime status, computes health, and sends changes to the Podwatch dashboard.
 *
 * Health classification:
 *   healthy  — enabled, configured, running, recent messages
 *   degraded — running but no recent inbound/outbound (>30 min)
 *   down     — not running, or not configured, or has errors
 *
 * Uses `openclaw gateway call channels.status` (no probe) for fast local data.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelHealthStatus = "healthy" | "degraded" | "down";

export interface ChannelHealth {
  channelId: string;
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  mode: string | null;
  lastInboundAt: string | null;   // ISO timestamp
  lastOutboundAt: string | null;  // ISO timestamp
  lastError: string | null;
  status: ChannelHealthStatus;
  warnings: string[];
}

/**
 * Raw shape returned by `openclaw gateway call channels.status`.
 */
interface GatewayChannelsStatusResponse {
  ts: number;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channels?: Record<string, ChannelSummary>;
  channelAccounts?: Record<string, AccountSnapshot[]>;
  channelDefaultAccountId?: Record<string, string>;
}

interface ChannelSummary {
  configured?: boolean;
  running?: boolean;
  mode?: string;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  lastProbeAt?: number | null;
  tokenSource?: string;
}

interface AccountSnapshot {
  accountId: string;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  mode?: string;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  tokenSource?: string;
  allowUnmentionedGroups?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If no inbound/outbound in this window, consider degraded */
const DEGRADED_THRESHOLD_MS = 30 * 60 * 1_000; // 30 minutes

/** CLI command timeout */
const CLI_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastSnapshot: string | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let configuredEndpoint: string | null = null;
let configuredApiKey: string | null = null;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Fetch channel status from the local gateway via CLI.
 */
export async function fetchChannelStatus(): Promise<GatewayChannelsStatusResponse | null> {
  try {
    const { stdout } = await execFileAsync(
      "openclaw",
      ["gateway", "call", "channels.status", "--params", '{"probe":false}'],
      { timeout: CLI_TIMEOUT_MS },
    );

    // The CLI prefixes with "Gateway call: channels.status\n", then JSON
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) return null;

    const json = stdout.slice(jsonStart);
    return JSON.parse(json) as GatewayChannelsStatusResponse;
  } catch {
    return null;
  }
}

/**
 * Compute health status for a single channel account.
 */
export function computeChannelHealth(
  channelId: string,
  label: string,
  account: AccountSnapshot,
  now?: number,
): ChannelHealth {
  const currentTime = now ?? Date.now();
  const warnings: string[] = [];

  const enabled = account.enabled ?? true;
  const configured = account.configured ?? false;
  const running = account.running ?? false;

  let status: ChannelHealthStatus = "healthy";

  // Down conditions
  if (!enabled) {
    status = "down";
    warnings.push("Channel is disabled");
  } else if (!configured) {
    status = "down";
    warnings.push("Channel is not configured");
  } else if (!running) {
    status = "down";
    if (account.lastError) {
      warnings.push(`Last error: ${account.lastError}`);
    } else {
      warnings.push("Channel is not running");
    }
  }

  // Degraded conditions (only if otherwise healthy)
  if (status === "healthy") {
    const lastIn = account.lastInboundAt;
    const lastOut = account.lastOutboundAt;

    if (lastIn != null && currentTime - lastIn > DEGRADED_THRESHOLD_MS) {
      status = "degraded";
      warnings.push("No inbound messages in 30+ minutes");
    }

    if (lastOut != null && currentTime - lastOut > DEGRADED_THRESHOLD_MS) {
      if (status !== "degraded") status = "degraded";
      warnings.push("No outbound messages in 30+ minutes");
    }

    // No message history at all is not necessarily degraded (fresh setup)
    if (lastIn == null && lastOut == null && running) {
      // No data yet — still healthy, but note it
    }
  }

  return {
    channelId,
    accountId: account.accountId,
    name: label,
    enabled,
    configured,
    running,
    mode: account.mode ?? null,
    lastInboundAt: account.lastInboundAt != null
      ? new Date(account.lastInboundAt).toISOString()
      : null,
    lastOutboundAt: account.lastOutboundAt != null
      ? new Date(account.lastOutboundAt).toISOString()
      : null,
    lastError: account.lastError ?? null,
    status,
    warnings,
  };
}

/**
 * Build channel health list from gateway response.
 */
export function buildChannelHealthList(
  response: GatewayChannelsStatusResponse,
  now?: number,
): ChannelHealth[] {
  const results: ChannelHealth[] = [];
  const labels = response.channelLabels ?? {};
  const accounts = response.channelAccounts ?? {};
  const order = response.channelOrder ?? Object.keys(accounts);

  for (const channelId of order) {
    const channelAccounts = accounts[channelId];
    if (!Array.isArray(channelAccounts)) continue;

    const label = labels[channelId] ?? channelId;

    for (const account of channelAccounts) {
      if (!account || typeof account !== "object") continue;
      results.push(computeChannelHealth(channelId, label, account, now));
    }
  }

  return results;
}

/**
 * Check channel health and send changes to the dashboard.
 * Returns the computed channels (for testing).
 */
export async function checkChannelHealth(): Promise<ChannelHealth[]> {
  try {
    const response = await fetchChannelStatus();
    if (!response) return [];

    const channels = buildChannelHealthList(response);
    if (channels.length === 0) return [];

    // Change detection — only send if different from last snapshot
    const snapshot = JSON.stringify(channels);
    if (snapshot === lastSnapshot) {
      return channels; // No changes
    }

    lastSnapshot = snapshot;

    // Send to dashboard
    void sendChannelHealthToApi(channels);

    return channels;
  } catch (err) {
    try {
      console.error("[podwatch/channel-monitor] Error checking channel health:", err);
    } catch {
      // Swallow
    }
    return [];
  }
}

/**
 * Send channel health data to the Podwatch API.
 */
export async function sendChannelHealthToApi(channels: ChannelHealth[]): Promise<void> {
  if (!configuredEndpoint || !configuredApiKey) return;

  try {
    const response = await fetch(`${configuredEndpoint}/channel-health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${configuredApiKey}`,
      },
      body: JSON.stringify({
        type: "channel_health",
        channels: channels.map((ch) => ({
          channelId: ch.channelId,
          accountId: ch.accountId,
          name: ch.name,
          enabled: ch.enabled,
          configured: ch.configured,
          running: ch.running,
          mode: ch.mode,
          lastInboundAt: ch.lastInboundAt,
          lastOutboundAt: ch.lastOutboundAt,
          lastError: ch.lastError,
          status: ch.status,
          warnings: ch.warnings,
        })),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`[podwatch/channel-monitor] API ${response.status}`);
    }
  } catch (err) {
    try {
      console.error("[podwatch/channel-monitor] Failed to send channel health:", err);
    } catch {
      // Swallow
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the channel health monitor.
 */
export function startChannelMonitor(
  intervalMs: number,
  stateDir?: string,
  endpoint?: string,
  apiKey?: string,
): void {
  configuredEndpoint = endpoint ?? null;
  configuredApiKey = apiKey ?? null;

  // Stop any existing timer
  stopChannelMonitor();

  // Initial check
  void checkChannelHealth();

  // Schedule periodic checks
  monitorTimer = setInterval(() => {
    void checkChannelHealth();
  }, intervalMs);

  if (monitorTimer && typeof monitorTimer === "object" && "unref" in monitorTimer) {
    monitorTimer.unref();
  }
}

/**
 * Stop the channel health monitor.
 */
export function stopChannelMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Reset cached snapshot (for testing).
 */
export function _resetChannelMonitorState(): void {
  lastSnapshot = null;
  configuredEndpoint = null;
  configuredApiKey = null;
}
