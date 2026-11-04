import type { SessionEvent, SessionSummary } from "./events.js";
import { contentPartsText } from "./events.js";

const UNTITLED = "(untitled)";
const TITLE_LIMIT = 80;

function eventText(event: SessionEvent): string {
  const message = event.message as { content?: unknown } | undefined;
  const text = contentPartsText(message?.content);
  if (text) return text;
  return typeof event.content === "string" ? event.content : "";
}

function compactTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > TITLE_LIMIT
    ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
    : line;
}

/** First user message, unless a later session_renamed event supplies a title. */
export function sessionTitleFromEvents(events: SessionEvent[]): string {
  let firstUser: string | undefined;
  let renamed: string | undefined;
  for (const event of events) {
    if (event.type === "session_renamed") {
      const title = compactTitle(String(event.title ?? ""));
      if (title) renamed = title;
    } else if (!firstUser && event.type === "user_message") {
      firstUser = compactTitle(eventText(event));
    }
  }
  return renamed ?? firstUser ?? UNTITLED;
}

const MESSAGE_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_result",
]);

export function sessionMessageCount(events: SessionEvent[]): number {
  return events.filter((event) => MESSAGE_EVENT_TYPES.has(event.type)).length;
}

/** Case-insensitive haystack for title, content, and workspace search. */
export function sessionSearchText(events: SessionEvent[]): string {
  return events
    .filter(
      (event) =>
        event.type === "user_message" ||
        event.type === "assistant_message" ||
        event.type === "tool_result" ||
        event.type === "session_renamed",
    )
    .map((event) =>
      event.type === "session_renamed"
        ? String(event.title ?? "")
        : eventText(event),
    )
    .join("\n");
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

/**
 * Filter sessions by title, content, or workspace. Empty queries keep the
 * store's recency order; matches are ranked title > workspace > content.
 */
export function searchSessions(
  entries: SessionSummary[],
  query: string,
): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries.map((entry) => ({ ...entry }));

  const matches: Array<{ entry: SessionSummary; score: number }> = [];
  for (const entry of entries) {
    const title = (entry.title ?? "").toLowerCase();
    const workspace = entry.workspace.toLowerCase();
    const content = entry.searchText ?? "";
    const index = content.toLowerCase().indexOf(needle);
    let score = 0;
    if (title.includes(needle)) score += 3;
    if (workspace.includes(needle)) score += 2;
    if (index !== -1) score += 1;
    if (score === 0) continue;
    matches.push({
      entry:
        index === -1
          ? { ...entry }
          : {
              ...entry,
              snippet: snippetAround(content, index, needle.length),
            },
      score,
    });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? "");
  });
  return matches.map((match) => match.entry);
}

function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/** Stable tab-separated session table, suitable for CLI output and tests. */
export function formatSessionList(
  entries: SessionSummary[],
  options: { snippets?: boolean } = {},
): string {
  const header = [
    "ID",
    "TITLE",
    "UPDATED",
    "PROVIDER",
    "MESSAGES",
    "WORKSPACE",
  ];
  if (options.snippets) header.push("MATCH");
  const rows = entries.map((entry) => {
    const row = [
      entry.id,
      entry.title ?? UNTITLED,
      entry.updatedAt ?? "",
      entry.provider,
      entry.messageCount ?? 0,
      entry.workspace,
    ];
    if (options.snippets) row.push(entry.snippet ?? "");
    return row.map(cell).join("\t");
  });
  return [header.join("\t"), ...rows].join("\n");
}

export function formatSessionSearch(entries: SessionSummary[]): string {
  return formatSessionList(entries, { snippets: true });
}
