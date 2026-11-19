import type { Message } from "../types.js";
import { estimateMessageTokens } from "./budget.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Headings the compaction summarizer must return. */
export const SUMMARY_HEADINGS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
] as const;

export type CompactionStrategy = "summary" | "native";

/** Structured per-session memory produced by compaction. */
export interface MemoryCheckpoint {
  schemaVersion: number;
  summary: string;
  coveredCount: number;
  coveredTokens: number;
  keptCount: number;
  model: string;
  strategy: CompactionStrategy;
  usage?: { input?: number; output?: number };
  native?: { provider: string; model: string; payload: string };
}

export type Reserve =
  { kind: "percent"; value: number } | { kind: "tokens"; value: number };

/** Resolve the compaction reserve from the explicit setting or the legacy percent. */
export function resolveReserve(
  compactAtPercent: number,
  buffer?: string | number | null,
): Reserve {
  if (typeof buffer === "number" && Number.isFinite(buffer) && buffer >= 0) {
    return { kind: "tokens", value: Math.floor(buffer) };
  }
  if (typeof buffer === "string") {
    const match = /^(\d+(?:\.\d+)?)%$/.exec(buffer.trim());
    if (match) {
      const value = Number(match[1]);
      if (value >= 1 && value <= 99) return { kind: "percent", value };
    }
  }
  return {
    kind: "percent",
    value: Math.min(99, Math.max(1, 100 - compactAtPercent)),
  };
}

/** Apply a reserve to a token budget and return the compaction threshold. */
export function thresholdFromReserve(budget: number, reserve: Reserve): number {
  if (reserve.kind === "tokens") {
    return Math.max(1, budget - reserve.value);
  }
  const reserveTokens = (budget * reserve.value) / 100;
  const floored =
    budget >= 32_000 ? Math.max(reserveTokens, 16_000) : reserveTokens;
  return Math.max(1, Math.floor(budget - floored));
}

/** Build the structured summary prompt, including update mode when a prior checkpoint exists. */
export function buildSummaryPrompt(options: {
  focus?: string;
  previous?: string | null;
}): string {
  const prior = options.previous
    ? `Update the existing checkpoint using the conversation since it. Keep what still holds; do not rewrite it from scratch.\n\nExisting checkpoint:\n${options.previous}\n`
    : "Write a new checkpoint from the conversation below.";
  return [
    "Summarize the following conversation history compactly so another agent can continue the work.",
    "Retain: (1) every user-assigned task and its acceptance criteria, marking completed vs pending; (2) the current task and the next action; (3) files touched and their last known state (paths with a brief change summary); (4) decisions, constraints, and rejected approaches; (5) verification commands and their results. Never drop an open task or a user constraint. Drop: full tool outputs and intermediate reasoning.",
    "Use exactly these headings, in this order, with terse bullets under each:",
    ...SUMMARY_HEADINGS,
    "Work State must distinguish Completed, Active, and Blocked. Relevant Files is capped at 15 entries. Keep exact paths, symbols, and commands. Drop questions that were resolved. Do not mention compaction.",
    prior,
    options.focus ? `Focus the summary on: ${options.focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Nudge sent once when a summary does not contain the full heading set. */
export function summaryNudge(): string {
  return `The required headings are missing. Rewrite the full summary using all of these required headings:\n${SUMMARY_HEADINGS.join("\n")}`;
}

export function hasAllSummaryHeadings(text: string): boolean {
  return SUMMARY_HEADINGS.every((heading) => text.includes(heading));
}

/** Shrink steps used when a provider rejects a summary as too long. */
export const SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35] as const;

export function isOverflowError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /too long|context length|maximum context|payload too large|request entity too large|token limit/i.test(
    text,
  );
}

export interface TailSplit {
  recent: Message[];
  older: Message[];
  keptCount: number;
  keptTokens: number;
}

/**
 * Keep the newest messages that fit the keep budget, starting on a user message
 * so a tool call and its result are never split. `safetyCap` bounds the tail
 * on small windows.
 */
export function splitRecentTail(
  history: Message[],
  keepTokens: number,
  safetyCap: number,
): TailSplit {
  if (history.length === 0) {
    return { recent: [], older: [], keptCount: 0, keptTokens: 0 };
  }
  const limit = Math.max(0, Math.min(keepTokens, safetyCap));
  let start = history.length;
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(history[i]);
    if (start < history.length && tokens + cost > limit) break;
    tokens += cost;
    start = i;
  }
  while (start < history.length - 1 && history[start].role !== "user") {
    tokens -= estimateMessageTokens(history[start]);
    start++;
  }
  if (start >= history.length) {
    start = history.length - 1;
    tokens = estimateMessageTokens(history[start]);
  }
  while (tokens > limit && history.length - start > 1) {
    tokens -= estimateMessageTokens(history[start]);
    start++;
  }
  // The cap pass may have crossed a user boundary; snap forward again so the
  // tail never starts in the middle of a tool call and its result.
  while (start < history.length - 1 && history[start].role !== "user") {
    tokens -= estimateMessageTokens(history[start]);
    start++;
  }
  return {
    recent: history.slice(start),
    older: history.slice(0, start),
    keptCount: history.length - start,
    keptTokens: Math.max(0, tokens),
  };
}

/** Guarantee at least one older message so a forced compaction can run. */
export function withOlder(split: TailSplit): TailSplit {
  if (split.older.length > 0 || split.recent.length <= 1) return split;
  const first = split.recent[0];
  return {
    recent: split.recent.slice(1),
    older: [first],
    keptCount: split.recent.length - 1,
    keptTokens: Math.max(0, split.keptTokens - estimateMessageTokens(first)),
  };
}
