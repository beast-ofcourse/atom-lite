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
    const text =
      message.content
        ?.map((p: any) => (p?.type === "text" ? p.text : ""))
        .join("") ?? "";
    return {
      type: "user_message",
      timestamp,
      sessionId,
      seq,
      content: text,
      message,
    };
  }
  if (message.role === "assistant") {
    const text =
      message.content
        ?.map((p: any) => (p?.type === "text" ? p.text : ""))
        .join("") ?? "";
    return {
      type: "assistant_message",
      timestamp,
      sessionId,
      seq,
      content: text,
      message,
      toolCalls: message.toolCalls,
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
    };
  }
  return null;
}

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const r = (value as any).role;
  return r === "system" || r === "user" || r === "assistant" || r === "tool";
}
