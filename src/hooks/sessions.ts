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
      try {
        if (!event || typeof event !== "object") return;
        const safeCtx = (ctx && typeof ctx === "object") ? ctx : {} as { agentId?: string; sessionId: string };

        transmitter.enqueue({
          type: "session_start",
          ts: Date.now(),
          sessionId: event.sessionId ?? undefined,
          resumedFrom: event.resumedFrom,
          agentId: safeCtx.agentId,
        });
      } catch (err) {
        try { console.error("[podwatch/sessions] session_start handler error:", err); } catch {}
      }
    },
    { name: "podwatch-session-start" }
  );

  // -----------------------------------------------------------------------
  // session_end — includes loop detection
  // -----------------------------------------------------------------------
  api.on(
    "session_end",
    async (event: SessionEndEvent, ctx: { agentId?: string; sessionId: string }): Promise<void> => {
      try {
        if (!event || typeof event !== "object") return;
        const safeCtx = (ctx && typeof ctx === "object") ? ctx : {} as { agentId?: string; sessionId: string };

        const messageCount = typeof event.messageCount === "number" ? event.messageCount : 0;

        transmitter.enqueue({
          type: "session_end",
          ts: Date.now(),
          sessionId: event.sessionId ?? undefined,
          messageCount,
          durationMs: event.durationMs,
          agentId: safeCtx.agentId,
        });

        // Simple loop detection: sessions with > 100 messages are suspicious
        if (messageCount > 100) {
          transmitter.enqueue({
            type: "alert",
            ts: Date.now(),
            severity: "warning",
            pattern: "session_loop_warning",
            sessionKey: safeCtx.sessionId,
            messageCount,
            agentId: safeCtx.agentId,
          });
        }
      } catch (err) {
        try { console.error("[podwatch/sessions] session_end handler error:", err); } catch {}
      }
    },
    { name: "podwatch-session-end" }
  );

  api.logger.info("[podwatch/sessions] Session lifecycle handlers registered");
}
