/**
 * Session handlers — session_start and session_end.
 *
 * Tracks session lifecycle for timeline, loop detection, and duration metrics.
 */

import type {
  SessionStartEvent,
  SessionEndEvent,
  PluginHookAgentContext,
} from "../types.js";
import { transmitter } from "../transmitter.js";

// Track active sessions for loop detection
const activeSessions = new Map<string, { startTs: number; messageCount: number }>();

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
      activeSessions.set(event.sessionId, {
        startTs: Date.now(),
        messageCount: 0,
      });

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
      const session = activeSessions.get(event.sessionId);
      activeSessions.delete(event.sessionId);

      const sessionEvent: Record<string, unknown> = {
        type: "session_end",
        ts: Date.now(),
        sessionId: event.sessionId,
        messageCount: event.messageCount,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
      };

      // Loop detection: high message count in short duration
      if (event.durationMs && event.messageCount > 0) {
        const messagesPerMinute = (event.messageCount / (event.durationMs / 60_000));
        if (messagesPerMinute > 30 && event.messageCount > 50) {
          sessionEvent.loopDetected = true;
          sessionEvent.messagesPerMinute = Math.round(messagesPerMinute);
        }
      }

      transmitter.enqueue(sessionEvent as any);
    }
  );

  api.logger.info("[podwatch/sessions] Session lifecycle handlers registered");
}
