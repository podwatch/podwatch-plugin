/**
 * Session handlers — session_start and session_end.
 *
 * Tracks session lifecycle for timeline, loop detection, and duration metrics.
 */

import type {
  SessionStartEvent,
  SessionEndEvent,
} from "../types.js";
import { transmitter } from "../transmitter.js";

/**
 * Register session lifecycle handlers.
 */
export function registerSessionHandlers(api: any): void {
  // -----------------------------------------------------------------------
  // session_start
  // -----------------------------------------------------------------------
  api.on(
    "session_start",
    async (event: SessionStartEvent, ctx: { agentId?: string; sessionId: string }): Promise<void> => {
      transmitter.enqueue({
        type: "session_start",
        ts: Date.now(),
        sessionId: event.sessionId,
        resumedFrom: event.resumedFrom,
        agentId: ctx.agentId,
      });
    }
  );

  // -----------------------------------------------------------------------
  // session_end — includes loop detection
  // -----------------------------------------------------------------------
  api.on(
    "session_end",
    async (event: SessionEndEvent, ctx: { agentId?: string; sessionId: string }): Promise<void> => {
      transmitter.enqueue({
        type: "session_end",
        ts: Date.now(),
        sessionId: event.sessionId,
        messageCount: event.messageCount,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
      });

      // Simple loop detection: sessions with > 100 messages are suspicious
      if (event.messageCount > 100) {
        transmitter.enqueue({
          type: "alert",
          ts: Date.now(),
          severity: "warning",
          pattern: "session_loop_warning",
          sessionKey: ctx.sessionId,
          messageCount: event.messageCount,
          agentId: ctx.agentId,
        });
      }
    }
  );

  api.logger.info("[podwatch/sessions] Session lifecycle handlers registered");
}
