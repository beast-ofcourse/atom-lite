import type { Message } from "../types.js";

export interface SessionEvent {
  type: string;
  timestamp: string;
  sessionId: string;
  seq: number;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  workspace: string;
  provider: string;
  createdAt?: string;
  updatedAt?: string;
  eventCount?: number;
  filePath?: string;
  /** Derived title: first user message or the latest session_renamed title. */
  title?: string;
  /** Number of retained user, assistant, and tool messages. */
  messageCount?: number;
  /** Combined title/content/workspace haystack used by session search. */
  searchText?: string;
  /** Matching excerpt, populated by searchSessions. */
  snippet?: string;
}

export function contentPartsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function messageToEvent(
  message: Message,
  sessionId: string,
  seq: number,
): SessionEvent {
  const timestamp = nowIso();
  if (message.role === "user") {
    return {
      type: "user_message",
      timestamp,
      sessionId,
      seq,
      message,
    };
  }
  if (message.role === "assistant") {
    return {
      type: "assistant_message",
      timestamp,
      sessionId,
      seq,
      message,
    };
  }
  if (message.role === "tool") {
    return {
      type: "tool_result",
      timestamp,
      sessionId,
      seq,
      toolCallId: message.toolCallId,
      name: message.name,
      content: message.content,
      isError: message.isError,
      diff: Array.isArray(message.diff) ? message.diff : undefined,
    };
  }
  return { type: "assistant_message", timestamp, sessionId, seq, message };
}

export function eventToMessage(event: SessionEvent): Message | null {
  if (event.type === "user_message") {
    if (event.message && typeof event.message === "object") {
      return event.message as Message;
    }
    return {
      role: "user",
      content: [{ type: "text", text: String(event.content ?? "") }],
    };
  }
  if (event.type === "assistant_message") {
    if (event.message && typeof event.message === "object") {
      return event.message as Message;
    }
    const toolCalls = Array.isArray(event.toolCalls)
      ? (event.toolCalls as any)
      : undefined;
    return {
      role: "assistant",
      content: event.content
        ? [{ type: "text", text: String(event.content) }]
        : undefined,
      toolCalls,
    };
  }
  if (event.type === "tool_result") {
    return {
      role: "tool",
      toolCallId: String(event.toolCallId ?? ""),
      name: String(event.name ?? ""),
      content: String(event.content ?? ""),
      isError: event.isError === true,
      diff: Array.isArray(event.diff) ? (event.diff as string[]) : undefined,
    };
  }
  return null;
}

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const r = (value as any).role;
  return r === "system" || r === "user" || r === "assistant" || r === "tool";
}
