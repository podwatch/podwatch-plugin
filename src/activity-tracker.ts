/**
 * Activity tracker — singleton module that records agent activity timestamps.
 *
 * Used by the auto-updater to defer gateway restarts until the agent is idle,
 * preventing mid-conversation disruptions.
 *
 * Hook handlers call recordActivity() on every meaningful event
 * (before_agent_start, before_tool_call, message_received, etc.).
 * The updater calls isInactive() to check if enough idle time has passed.
 */

// Default inactivity threshold: 15 minutes
const DEFAULT_THRESHOLD_MS = 15 * 60 * 1000;

/** Module-level singleton timestamp of the last recorded activity. */
let lastActivityTs: number = 0;

/**
 * Record that agent activity just occurred.
 * Call this from hook handlers on every meaningful event.
 */
export function recordActivity(): void {
  lastActivityTs = Date.now();
}

/**
 * Get the timestamp of the last recorded activity.
 * Returns 0 if no activity has been recorded yet.
 */
export function getLastActivityTs(): number {
  return lastActivityTs;
}

/**
 * Check whether the agent has been inactive for at least `thresholdMs`.
 *
 * Returns true if:
 * - No activity has ever been recorded (lastActivityTs === 0), OR
 * - The time since last activity exceeds the threshold.
 *
 * @param thresholdMs Minimum idle time in ms (default: 15 minutes)
 */
export function isInactive(thresholdMs: number = DEFAULT_THRESHOLD_MS): boolean {
  if (lastActivityTs === 0) return true;
  return Date.now() - lastActivityTs >= thresholdMs;
}

/**
 * Reset the activity tracker state. Used for testing.
 * @internal
 */
export function _resetForTesting(): void {
  lastActivityTs = 0;
}
