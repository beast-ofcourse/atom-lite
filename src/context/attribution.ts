import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import { estimateMessageTokens } from "./budget.js";

export type AttributionCategory =
  | "systemPrompt"
  | "staticMessages"
  | "projectInstructions"
  | "sessionMemory"
  | "history";

/** Estimated tokens contributed by each part of an outgoing message list. */
export interface MessageAttribution {
  systemPrompt: number;
  staticMessages: number;
  projectInstructions: number;
  sessionMemory: number;
  history: number;
  toolDefinitions: number;
}

export interface PrefixInfo {
  bytes: number;
  hash: string;
  changed: boolean;
}

/** Section categories captured when the context manager builds a message list. */
export interface MessageLayout {
  /** One category per message, in the exact order the list was built. */
  categories: AttributionCategory[];
  /** Number of leading messages that form the cacheable stable prefix. */
  prefixEnd: number;
  toolTokenOverhead: number;
  compacted: boolean;
}

const layouts = new WeakMap<Message[], MessageLayout>();
const previousPrefixes = new Map<string, string[]>();
const MAX_TRACKED_PREFIXES = 256;

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

function classifyByContent(
  messages: Message[],
  toolOverhead: number,
): { attribution: MessageAttribution; categories: AttributionCategory[] } {
  const result = emptyAttribution(toolOverhead);
  const categories: AttributionCategory[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const tokens = estimateMessageTokens(message);
    const text = Array.isArray(message.content)
      ? message.content.find((p) => p.type === "text")?.text
      : undefined;
    let category: AttributionCategory = "history";
    if (i === 0 && message.role === "system") category = "systemPrompt";
    else if (
      message.role === "assistant" &&
      typeof text === "string" &&
      text.startsWith("Context summary")
    )
      category = "sessionMemory";
    categories.push(category);
    result[category] += tokens;
  }
  return { attribution: result, categories };
}

function measurePrefix(
  messages: Message[],
  sessionId: string,
): PrefixInfo | undefined {
  if (messages.length === 0) return undefined;
  // Compare per message: a growing history appends to the prefix without
  // changing the bytes already cached, so growth is not prefix drift.
  const parts = messages.map((message) => JSON.stringify(message));
  const joined = parts.join("\n");
  const bytes = Buffer.byteLength(joined, "utf8");
  const hash = createHash("sha256").update(joined).digest("hex");
  const key = sessionId || "(anonymous)";
  const previous = previousPrefixes.get(key);
  const changed =
    previous !== undefined &&
    (parts.length < previous.length ||
      previous.some((part, index) => part !== parts[index]));
  previousPrefixes.set(key, parts);
  // A long-lived server sees far more sessions than it keeps in memory. Map
  // preserves insertion order, so evict the oldest entry once the cap is hit.
  if (previousPrefixes.size > MAX_TRACKED_PREFIXES) {
    const oldest = previousPrefixes.keys().next().value;
    if (oldest !== undefined) previousPrefixes.delete(oldest);
  }
  return { bytes, hash, changed };
}

/**
 * Attribute the final outgoing message list. Extension hooks may mutate the
 * array in place; a resized or replaced array invalidates the captured layout,
 * in which case content-based classification is used instead.
 */
export function attributeMessages(
  messages: Message[],
  sessionId = "",
): {
  attribution: MessageAttribution;
  compacted: boolean;
  prefix?: PrefixInfo;
} {
  const layout = layouts.get(messages);
  if (!layout || layout.categories.length !== messages.length) {
    const fallback = classifyByContent(
      messages,
      layout?.toolTokenOverhead ?? 0,
    );
    return {
      attribution: fallback.attribution,
      compacted: layout?.compacted ?? false,
    };
  }

  const attribution = emptyAttribution(layout.toolTokenOverhead);
  for (let i = 0; i < messages.length; i++) {
    attribution[layout.categories[i]] += estimateMessageTokens(messages[i]);
  }
  return {
    attribution,
    compacted: layout.compacted,
    prefix:
      layout.prefixEnd > 0
        ? measurePrefix(messages.slice(0, layout.prefixEnd), sessionId)
        : undefined,
  };
}

export function attributeSummaryMessages(
  messages: Message[],
): MessageAttribution {
  return classifyByContent(messages, 0).attribution;
}
