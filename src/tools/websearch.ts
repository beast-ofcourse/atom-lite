import { DomUtils, parseDocument } from "htmlparser2";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    query: z.string(),
    num_results: z.number().int().positive().optional(),
  })
  .strict();

interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string;
}

interface RankedResult extends SearchResult {
  score: number;
}

function canonicalUrl(raw: string, base = "https://duckduckgo.com"): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
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

function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
  const scored = results.map((result) => {
    const title = result.title.toLowerCase();
    const content = result.content.toLowerCase();
    const titleHits = terms.filter((term) => title.includes(term)).length;
    const contentHits = terms.filter((term) => content.includes(term)).length;
    return { ...result, score: titleHits * 2 + contentHits };
  });
  const byScore = [...scored].sort(
    (a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
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
    .sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map(({ score: _score, ...result }) => result);
}

function structured(result: SearchResult): Record<string, string> {
  return {
    title: result.title,
    url: result.url,
    content: result.content,
    ...(result.published === undefined ? {} : { published: result.published }),
  };
}

export const websearchTool: Tool = {
  definition: {
    name: "websearch",
    description:
      "Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        num_results: { type: "integer", minimum: 1 },
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
    const configured = Math.min(ctx.web?.search.maxResults ?? 8, 20);
    const limit = Math.min(parsed.data.num_results ?? configured, configured, 20);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": "atom-lite/0.1",
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: controller.signal,
        });
      } catch (err) {
        return {
          toolCallId: call.id,
          name: "websearch",
          content: `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (!res.ok) {
        return {
          toolCallId: call.id,
          name: "websearch",
          content: `PROVIDER_INVALID_RESPONSE: ${res.status}`,
          isError: true,
        };
      }
      const rawLength = res.headers.get("content-length");
      const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
      const maxBytes = ctx.web?.fetch.maxBytes ?? 5_242_880;
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return {
          toolCallId: call.id,
          name: "websearch",
          content: "PROVIDER_INVALID_RESPONSE: search response too large",
          isError: true,
        };
      }
      const html = await res.text();
      const ranked = rankResults(parseResults(html), query).slice(0, limit);
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
      if (output.length > cap) output = output.slice(0, cap) + "\nOUTPUT_TRUNCATED";
      return {
        toolCallId: call.id,
        name: "websearch",
        content: output,
        structuredContent: ranked.map(structured),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
