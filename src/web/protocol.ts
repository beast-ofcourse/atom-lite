import type { AgentEvent } from "../agent/types.js";
import type { SessionEvent, SessionSummary } from "../sessions/events.js";

/**
 * The JSON protocol between the browser and `atom-lite --serve`. Kept in one
 * place so the server and its tests share the same vocabulary; the browser
 * client (`web/app.js`) mirrors it in the comment at the top of the file.
 */

export type ClientMessage =
  | { type: "input"; text: string }
  | {
      type: "approval";
      id: string;
      /** Turn the answer belongs to; rejected when it does not match. */
      turnId?: number;
      decision: "approve" | "deny" | "trust-session";
    }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "resume_session"; id: string };

export type SessionListing = Pick<
  SessionSummary,
  "id" | "title" | "updatedAt" | "messageCount"
>;

export interface SessionState {
  sessionId: string;
  history: SessionEvent[];
}

export type ServerMessage =
  | {
      type: "hello";
      sessionId: string;
      provider: string;
      model: string;
      readOnly: boolean;
      history: SessionEvent[];
    }
  | { type: "event"; event: AgentEvent }
  | { type: "user_input"; text: string }
  | { type: "turn_start"; turnId: number }
  | { type: "turn_end" }
  | { type: "input_queued"; text: string }
  | {
      type: "approval_request";
      id: string;
      turnId: number;
      request: {
        command: string;
        cwd: string;
        timeoutMs: number;
        sandboxed: boolean;
        tool?: string;
      };
    }
  | { type: "sessions"; sessions: SessionListing[] }
  | ({ type: "session_changed" } & SessionState)
  | { type: "control"; readOnly: boolean }
  | { type: "error"; message: string };

export type ClientParseResult = { message: ClientMessage } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse one WebSocket text frame into a known message, or an error string. */
export function parseClientMessage(raw: string): ClientParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "malformed message" };
  }
  if (!isRecord(value)) return { error: "malformed message" };
  switch (value.type) {
    case "input":
      if (typeof value.text !== "string") {
        return { error: "input text must be a string" };
      }
      return { message: { type: "input", text: value.text } };
    case "approval": {
      const decision = value.decision;
      if (
        decision !== "approve" &&
        decision !== "deny" &&
        decision !== "trust-session"
      ) {
        return { error: "invalid approval decision" };
      }
      if (typeof value.id !== "string" || !value.id) {
        return { error: "approval id must be a string" };
      }
      return {
        message: {
          type: "approval",
          id: value.id,
          turnId: typeof value.turnId === "number" ? value.turnId : undefined,
          decision,
        },
      };
    }
    case "list_sessions":
      return { message: { type: "list_sessions" } };
    case "new_session":
      return { message: { type: "new_session" } };
    case "resume_session":
      if (typeof value.id !== "string" || !value.id) {
        return { error: "resume_session id must be a string" };
      }
      return { message: { type: "resume_session", id: value.id } };
    default:
      return { error: "unknown message type" };
  }
}
