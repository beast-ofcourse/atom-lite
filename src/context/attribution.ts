import type { Message } from "../types.js";
import { estimateMessageTokens } from "./budget.js";

/** Estimated tokens contributed by each part of an outgoing message list. */
export interface MessageAttribution {
  systemPrompt: number;
  staticMessages: number;
  projectInstructions: number;
  sessionMemory: number;
  history: number;
  toolDefinitions: number;
}

/** Section boundaries captured when the context manager builds a message list. */
export interface MessageLayout {
  systemPromptEnd: number;
  staticMessagesEnd: number;
  instructionsEnd: number;
  sessionMemoryEnd: number;
  historyEnd: number;
  toolTokenOverhead: number;
  compacted: boolean;
}

const layouts = new WeakMap<Message[], MessageLayout>();

export function rememberMessageLayout(
  messages: Message[],
  layout: MessageLayout,
): void {
  layouts.set(messages, layout);
}

function emptyAttribution(toolOverhead: number): MessageAttribution {
  return {
    systemPrompt: 0,
    staticMessages: 0,
    projectInstructions: 0,
    sessionMemory: 0,
    history: 0,
    toolDefinitions: toolOverhead,
  };
}

/** Fallback for message lists built outside the context manager. */
function classifyByContent(
  messages: Message[],
  toolOverhead: number,
): MessageAttribution {
  const result = emptyAttribution(toolOverhead);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const tokens = estimateMessageTokens(message);
    const text = Array.isArray(message.content)
      ? message.content.find((p) => p.type === "text")?.text
      : undefined;
    if (i === 0 && message.role === "system") {
      result.systemPrompt += tokens;
    } else if (
      message.role === "assistant" &&
      typeof text === "string" &&
      text.startsWith("Context summary")
    ) {
      result.sessionMemory += tokens;
    } else {
      result.history += tokens;
    }
  }
  return result;
}

/**
 * Attribute the final outgoing message list. Extension hooks may mutate the
 * array in place; a resized or replaced array invalidates the captured layout,
 * in which case content-based classification is used instead.
 */
export function attributeMessages(messages: Message[]): {
  attribution: MessageAttribution;
  compacted: boolean;
} {
  const layout = layouts.get(messages);
  if (!layout || layout.historyEnd !== messages.length) {
    return {
      attribution: classifyByContent(messages, layout?.toolTokenOverhead ?? 0),
      compacted: layout?.compacted ?? false,
    };
  }

  const attribution = emptyAttribution(layout.toolTokenOverhead);
  for (let i = 0; i < messages.length; i++) {
    const tokens = estimateMessageTokens(messages[i]);
    if (i < layout.systemPromptEnd) attribution.systemPrompt += tokens;
    else if (i < layout.staticMessagesEnd) attribution.staticMessages += tokens;
    else if (i < layout.instructionsEnd) attribution.projectInstructions += tokens;
    else if (i < layout.sessionMemoryEnd) attribution.sessionMemory += tokens;
    else attribution.history += tokens;
  }
  return { attribution, compacted: layout.compacted };
}

export function attributeSummaryMessages(messages: Message[]): MessageAttribution {
  return classifyByContent(messages, 0);
}
