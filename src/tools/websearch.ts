import { DomUtils, parseDocument } from "htmlparser2";
import { createBoundedCache } from "./web-cache.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

type ProviderId = "tavily" | "brave" | "exa" | "serper" | "ddg";
type ProviderSelection = ProviderId | "auto";
type Freshness = "fast" | "fresh" | "strict";

const ArgsSchema = z
  .object({
    query: z.string(),
    num_results: z.number().int().positive().optional(),
    freshness: z.enum(["fast", "fresh", "strict"]).optional(),
  })
  .strict();

const CACHE_MAX_ENTRIES = 64;
const DEFAULT_COOLDOWN_MS = 60_000;
const PROVIDER_ORDER: Exclude<ProviderId, "ddg">[] = [
  "tavily",
  "brave",
  "exa",
  "serper",
];
const PROVIDER_KEYS: Record<Exclude<ProviderId, "ddg">, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
  exa: "EXA_API_KEY",
  serper: "SERPER_API_KEY",
};

interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string;
}

interface RankedResult extends SearchResult {
  score: number;
}

interface SearchCacheEntry {
  content: string;
  structured: Record<string, string>[];
  createdAt: number;
}

interface ProviderOutcome {
  ok: boolean;
  results?: SearchResult[];
  rateLimited?: boolean;
  retryAfter?: string | null;
}

const searchCache = createBoundedCache<SearchCacheEntry>(CACHE_MAX_ENTRIES);
const refreshing = new Set<string>();
const cooldowns = new Map<Exclude<ProviderId, "ddg">, number>();

function cacheKey(
  query: string,
  provider: ProviderSelection,
  limit: number,
): string {
  return `search\n${provider}\n${limit}\n${query.trim().toLowerCase()}`;
}

function canonicalUrl(
  raw: string,
  base = "https://duckduckgo.com",
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return undefined;
  parsed.hash = "";
  parsed.host = parsed.host.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("utm_") ||
      ["fbclid", "gclid", "ref", "ref_src", "source"].includes(lower)
    ) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.href;
}

function resultUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let direct: URL;
  try {
    direct = new URL(href, "https://duckduckgo.com");
  } catch {
    return undefined;
  }
  const wrapped = direct.searchParams.get("uddg");
  return canonicalUrl(wrapped ?? href);
}

function parseResults(html: string): SearchResult[] {
  const doc = parseDocument(html);
  const links = DomUtils.getElementsByClassName(
    "result__a",
    doc.children,
    true,
  );
  const snippets = DomUtils.getElementsByClassName(
    "result__snippet",
    doc.children,
    true,
  );
  const unique = new Map<string, SearchResult>();
  links.forEach((link, index) => {
    const url = resultUrl(DomUtils.getAttributeValue(link, "href"));
    if (!url || unique.has(url)) return;
    const title = DomUtils.textContent(link).trim();
    const content = snippets[index]
      ? DomUtils.textContent(snippets[index]).trim()
      : "";
    unique.set(url, { title, url, content });
  });
  return [...unique.values()];
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const key = canonicalUrl(result.url) ?? result.url;
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()];
}

function compareScore(
  a: { score: number; url: string },
  b: { score: number; url: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = results.map((result) => {
    const title = result.title.toLowerCase();
    const content = result.content.toLowerCase();
    const titleHits = terms.filter((term) => title.includes(term)).length;
    const contentHits = terms.filter((term) => content.includes(term)).length;
    return { ...result, score: titleHits * 2 + contentHits };
  });
  const byScore = [...scored].sort(compareScore);
  const domains = new Map<string, number>();
  const diverse: RankedResult[] = byScore.map((result) => {
    let domain = "";
    try {
      domain = new URL(result.url).hostname;
    } catch {
      domain = result.url;
    }
    const seen = domains.get(domain) ?? 0;
    domains.set(domain, seen + 1);
    return { ...result, score: result.score - 0.75 * seen };
  });
  return diverse
    .sort(compareScore)
    .map(({ score: _score, ...result }) => result);
}

function toStructuredContent(result: SearchResult): Record<string, string> {
  return {
    title: result.title,
    url: result.url,
    content: result.content,
    ...(result.published === undefined ? {} : { published: result.published }),
  };
}

/** Read a response with a hard byte bound, even when chunked. */
async function readBoundedText(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; tooLarge: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return { text: "", tooLarge: true };
    return { text: new TextDecoder().decode(buf), tooLarge: false };
  }
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { text: "", tooLarge: true };
      }
      pieces.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  return { text: pieces.join("") + decoder.decode(), tooLarge: false };
}

function parseRetryAfter(value: string | null): number {
  if (value?.trim()) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return DEFAULT_COOLDOWN_MS;
}

function asResults(
  rows: unknown,
  fields: { title: string; url: string; content: string; published?: string },
): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const out: SearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const title = item[fields.title];
    const url = item[fields.url];
    const content = item[fields.content];
    const published = fields.published ? item[fields.published] : undefined;
    if (typeof title !== "string" || typeof url !== "string") continue;
    out.push({
      title,
      url,
      content: typeof content === "string" ? content : "",
      ...(typeof published === "string" ? { published } : {}),
    });
  }
  return out;
}

async function executeProvider(
  id: Exclude<ProviderId, "ddg">,
  query: string,
  limit: number,
  apiKey: string | undefined,
  signal: AbortSignal,
  maxBytes: number,
): Promise<ProviderOutcome> {
  if (!apiKey) return { ok: false, rateLimited: false };
  let url: string;
  let init: RequestInit;
  try {
    switch (id) {
      case "tavily":
        url = "https://api.tavily.com/search";
        init = {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            chunks_per_source: 3,
            max_results: limit,
          }),
        };
        break;
      case "brave": {
        const params = new URLSearchParams({ q: query, count: String(limit) });
        url = `https://api.search.brave.com/res/v1/web/search?${params}`;
        init = { headers: { "X-Subscription-Token": apiKey } };
        break;
      }
      case "exa":
        url = "https://api.exa.ai/search";
        init = {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ query, numResults: limit }),
        };
        break;
      case "serper":
        url = "https://google.serper.dev/search";
        init = {
          method: "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, num: limit }),
        };
        break;
    }
  } catch {
    return { ok: false, rateLimited: false };
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch {
    return { ok: false, rateLimited: false };
  }
  const retryAfter = res.headers.get("retry-after");
  if (res.status === 429) {
    await res.body?.cancel();
    return { ok: false, rateLimited: true, retryAfter };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, rateLimited: false };
  }
  const body = await readBoundedText(res, maxBytes);
  if (body.tooLarge) return { ok: false, rateLimited: false };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.text) as Record<string, unknown>;
  } catch {
    return { ok: false, rateLimited: false };
  }
  switch (id) {
    case "tavily":
      return {
        ok: true,
        results: dedupeResults(
          asResults(payload.results, {
            title: "title",
            url: "url",
            content: "content",
          }),
        ),
      };
    case "brave":
      return {
        ok: true,
        results: dedupeResults(
          asResults(
            (payload.web as Record<string, unknown> | undefined)?.results,
            { title: "title", url: "url", content: "description" },
          ),
        ),
      };
    case "exa":
      return {
        ok: true,
        results: dedupeResults(
          asResults(payload.results, {
            title: "title",
            url: "url",
            content: "text",
          }),
        ),
      };
    case "serper":
      return {
        ok: true,
        results: dedupeResults(
          asResults(payload.organic, {
            title: "title",
            url: "link",
            content: "snippet",
            published: "date",
          }),
        ),
      };
  }
}

async function executeDdg(
  query: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ProviderOutcome> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal,
    });
  } catch {
    return { ok: false, rateLimited: false };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, rateLimited: false };
  }
  const body = await readBoundedText(res, maxBytes);
  return body.tooLarge
    ? { ok: false, rateLimited: false }
    : { ok: true, results: parseResults(body.text) };
}

async function searchWithProviders(
  query: string,
  limit: number,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<{ results: SearchResult[]; error?: string }> {
  const configured = (ctx.web?.search.provider ?? "auto") as ProviderSelection;
  const fallback = ctx.web?.search.fallback ?? true;
  const keyFor = (id: Exclude<ProviderId, "ddg">) =>
    process.env[PROVIDER_KEYS[id]];
  const candidates: ProviderId[] = [];
  if (configured === "auto") {
    const eligible = PROVIDER_ORDER.filter((id) => keyFor(id));
    if (fallback) candidates.push(...eligible, "ddg");
    else if (eligible.length === 0) candidates.push("ddg");
    else candidates.push(eligible[0]);
  } else if (configured === "ddg") {
    candidates.push("ddg");
  } else {
    candidates.push(configured as ProviderId);
  }
  if (fallback) {
    for (const id of PROVIDER_ORDER) {
      if (id !== configured && keyFor(id) && !candidates.includes(id))
        candidates.push(id);
    }
    if (!candidates.includes("ddg")) candidates.push("ddg");
  }

  const maxBytes = ctx.web?.fetch.maxBytes ?? 5_242_880;
  let sawRateLimit = false;
  for (const id of candidates) {
    if (id !== "ddg") {
      const until = cooldowns.get(id);
      if (until !== undefined && until > Date.now()) continue;
    }
    const outcome =
      id === "ddg"
        ? await executeDdg(query, maxBytes, signal)
        : await executeProvider(id, query, limit, keyFor(id), signal, maxBytes);
    if (outcome.ok && outcome.results) return { results: outcome.results };
    if (!outcome.ok && id !== "ddg") {
      if (outcome.rateLimited) sawRateLimit = true;
      cooldowns.set(
        id,
        Date.now() +
          parseRetryAfter(
            outcome.rateLimited ? (outcome.retryAfter ?? null) : null,
          ),
      );
    }
  }
  return {
    results: [],
    error: sawRateLimit
      ? "WEBSEARCH_PROVIDER_RATE_LIMITED"
      : "WEBSEARCH_PROVIDER_UNAVAILABLE",
  };
}

export const websearchTool: Tool = {
  definition: {
    name: "websearch",
    description:
      "Search the web using the configured provider. Use this for current information beyond knowledge cutoff.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "integer", minimum: 1 },
        freshness: { type: "string", enum: ["fast", "fresh", "strict"] },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "websearch",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { query } = parsed.data;
    const freshness: Freshness = parsed.data.freshness ?? "fast";
    const configured = Math.min(ctx.web?.search.maxResults ?? 8, 20);
    const limit = Math.min(
      parsed.data.num_results ?? configured,
      configured,
      20,
    );
    const key = cacheKey(
      query,
      (ctx.web?.search.provider ?? "auto") as ProviderSelection,
      limit,
    );
    const ttlMs = (ctx.web?.search.cacheTtlSeconds ?? 120) * 1000;
    const cached = freshness === "strict" ? undefined : searchCache.get(key);

    const performSearch = async (): Promise<ToolResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const search = await searchWithProviders(
          query,
          limit,
          ctx,
          controller.signal,
        );
        if (search.error) {
          return {
            toolCallId: call.id,
            name: "websearch",
            content: search.error,
            isError: true,
          };
        }
        const ranked = rankResults(dedupeResults(search.results), query).slice(
          0,
          limit,
        );
        if (ranked.length === 0) {
          return {
            toolCallId: call.id,
            name: "websearch",
            content: "No results found.",
            structuredContent: [],
          };
        }
        const lines = ranked.map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`,
        );
        const cap = Math.min(30_000, ctx.maxToolOutputBytes ?? 30_000);
        let output = `Search: ${query}\n\n${lines.join("\n\n")}`;
        if (output.length > cap)
          output = output.slice(0, cap) + "\nOUTPUT_TRUNCATED";
        return {
          toolCallId: call.id,
          name: "websearch",
          content: output,
          structuredContent: ranked.map(toStructuredContent),
        };
      } finally {
        clearTimeout(timer);
      }
    };

    const cachedResult = (entry: SearchCacheEntry): ToolResult => ({
      toolCallId: call.id,
      name: "websearch",
      content: entry.content,
      structuredContent: entry.structured,
    });
    const storeResult = (target: string, result: ToolResult): void => {
      if (result.isError) return;
      searchCache.put(target, {
        content: result.content,
        structured: (result.structuredContent ?? []) as Record<
          string,
          string
        >[],
        createdAt: Date.now(),
      });
    };

    if (freshness === "fast" && cached) {
      const age = Date.now() - cached.createdAt;
      if (age <= ttlMs) return cachedResult(cached);
      if (age <= 10 * ttlMs) {
        if (!refreshing.has(key)) {
          refreshing.add(key);
          void (async () => {
            try {
              const result = await performSearch();
              storeResult(key, result);
            } catch {
              // Background refresh failures never disturb stale results.
            } finally {
              refreshing.delete(key);
            }
          })();
        }
        return cachedResult(cached);
      }
    }

    const result = await performSearch();
    if (freshness !== "strict") storeResult(key, result);
    return result;
  },
};
