import type { Message } from "../types.js";
import type { SessionEvent } from "./events.js";
import { contentPartsText } from "./events.js";

function contentText(content: unknown): string {
  return contentPartsText(content);
}

/**
 * Render retained messages for the restored transcript. System messages are
 * omitted: they are prompt scaffolding, not conversation history.
 */
export function sessionHistoryLines(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const text = contentText(message.content).trim();
      if (text) lines.push(`> ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = contentText(message.content).trim();
      if (text) lines.push(text);
      for (const call of message.toolCalls ?? []) {
        const args = JSON.stringify(call.arguments ?? {});
        lines.push(`⚙ ${call.name} ${args}`);
      }
      continue;
    }
    if (message.role === "tool") {
      const text = message.content.trim();
      if (text) lines.push(`[${message.name}] ${text}`);
    }
  }
  return lines;
}

export interface SessionSelection {
  provider?: string;
  model?: string;
}

/** Provider/model last selected inside a session, newest event wins. */
export function sessionSelectionFromEvents(
  events: SessionEvent[],
): SessionSelection {
  let provider: string | undefined;
  let model: string | undefined;
  for (const event of events) {
    if (event.type === "session_started") {
      provider = typeof event.provider === "string" ? event.provider : provider;
    } else if (
      event.type === "provider_selected" ||
      event.type === "model_switched"
    ) {
      provider = typeof event.provider === "string" ? event.provider : provider;
      model = typeof event.model === "string" ? event.model : model;
    }
  }
  return { provider, model };
}

/**
 * A short offer to switch provider/model when a resumed session differs from
 * the currently active one.
 */
export function providerSwitchNotice(
  current: SessionSelection,
  saved: SessionSelection,
): string | undefined {
  const savedLabel = saved.provider
    ? `${saved.provider}${saved.model ? `/${saved.model}` : ""}`
    : saved.model;
  const currentLabel = current.provider
    ? `${current.provider}${current.model ? `/${current.model}` : ""}`
    : current.model;
  if (!savedLabel || !currentLabel) return undefined;
  if (
    saved.provider &&
    current.provider &&
    saved.provider !== current.provider
  ) {
    return `this session used ${savedLabel}; current provider is ${currentLabel}. Run /model or /provider to switch.`;
  }
  if (saved.model && current.model && saved.model !== current.model) {
    return `this session used ${savedLabel}; current model is ${currentLabel}. Run /model to switch.`;
  }
  return undefined;
}
