import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

type Format = "text" | "markdown" | "html";
type Freshness = "fast" | "fresh" | "strict";

const ArgsSchema = z
  .object({
    url: z.string(),
    format: z.enum(["text", "markdown", "html"]).optional(),
    timeout: z.number().int().positive().optional(),
    freshness: z.enum(["fast", "fresh", "strict"]).optional(),
  })
  .strict();

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;
const CACHE_MAX_ENTRIES = 64;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "meta", "link", "noscript"]);

interface CacheEntry {
  content: string;
  etag?: string;
  lastModified?: string;
  createdAt: number;
}

const fetchCache = new Map<string, CacheEntry>();
const refreshing = new Set<string>();

function cacheKey(url: string, format: Format): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${format}\n${parsed.href}`;
  } catch {
    return `${format}\n${url}`;
  }
}

function cachePut(key: string, entry: CacheEntry): void {
  if (fetchCache.size >= CACHE_MAX_ENTRIES) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  fetchCache.set(key, entry);
}

function acceptHeader(format: Format): string {
  switch (format) {
    case "markdown":
      return "text/markdown, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
  }
}

function requestHeaders(
  format: Format,
  userAgent = "atom-lite/0.1",
): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: acceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  };
}

function effectiveOutputCap(ctx: ToolContext): number {
  return Math.min(
    ctx.web?.fetch.maxOutputChars ?? 30_000,
    ctx.maxToolOutputBytes ?? 30_000,
  );
}

interface BoundedBody {
  text: string;
  tooLarge: boolean;
}

/** Read only as much of the response as needed, cancelling on either limit. */
async function readBounded(
  res: Response,
  maxBytes: number,
  usefulTextLimit: number,
): Promise<BoundedBody> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return { text: "", tooLarge: true };
    return { text: new TextDecoder().decode(buf), tooLarge: false };
  }
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let bytes = 0;
  let useful = 0;
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0) {
        if (!VOID_TAGS.has(name)) skipDepth++;
        return;
      }
      if (SKIP_TAGS.has(name)) skipDepth++;
    },
    ontext(text) {
      if (skipDepth === 0) useful += text.length;
    },
    onclosetag(name) {
      if (skipDepth > 0 && !VOID_TAGS.has(name)) skipDepth--;
    },
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { text: "", tooLarge: true };
      }
      const text = decoder.decode(value, { stream: true });
      pieces.push(text);
      parser.write(text);
      if (useful >= usefulTextLimit) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    parser.end();
    reader.releaseLock();
  }
  return { text: pieces.join("") + decoder.decode(), tooLarge: false };
}

interface FetchOutcome {
  ok: boolean;
  content?: string;
  notModified?: boolean;
  noStore?: boolean;
  etag?: string;
  lastModified?: string;
  error?: string;
}

function convertBody(text: string, format: Format, contentType: string): string {
  const isHtml = contentType.includes("text/html") || text.trim().startsWith("<");
  if (format === "markdown" && isHtml) {
    try {
      return turndown.turndown(text);
    } catch {
      return stripHtml(text);
    }
  }
  if (format === "text" && isHtml) return stripHtml(text);
  return text;
}

export const webfetchTool: Tool = {
  definition: {
    name: "webfetch",
    description:
      "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        format: { type: "string", enum: ["text", "markdown", "html"] },
        timeout: { type: "integer", minimum: 1 },
        freshness: { type: "string", enum: ["fast", "fresh", "strict"] },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { url } = parsed.data;
    const format = parsed.data.format ?? "markdown";
    const freshness = parsed.data.freshness ?? "fast";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content:
          "TOOL_ARGUMENT_INVALID: URL must start with http:// or https://",
        isError: true,
      };
    }

    const key = cacheKey(url, format);
    const ttlMs = (ctx.web?.fetch.cacheTtlSeconds ?? 300) * 1000;
    const cached = freshness === "strict" ? undefined : fetchCache.get(key);

    const fetchAndRender = async (
      conditional?: Pick<CacheEntry, "etag" | "lastModified">,
    ): Promise<FetchOutcome> => {
      const timeoutMs = Math.min(
        (parsed.data.timeout ?? DEFAULT_TIMEOUT) * 1000,
        MAX_TIMEOUT * 1000,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const headers = requestHeaders(format);
      if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
      if (conditional?.lastModified)
        headers["If-Modified-Since"] = conditional.lastModified;
      try {
        let res: Response;
        try {
          res = await fetch(url, { headers, signal: controller.signal });
          if (res.status === 403) {
            await res.body?.cancel();
            try {
              res = await fetch(url, {
                headers: requestHeaders(format, "atom-lite/0.1 (compatible)"),
                signal: controller.signal,
              });
            } catch {
              // keep the original 403 response
            }
          }
        } catch (err) {
          return {
            ok: false,
            error: `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (res.status === 304) return { ok: true, notModified: true };
        if (!res.ok) {
          return {
            ok: false,
            error: `PROVIDER_INVALID_RESPONSE: ${res.status}`,
          };
        }
        const cap = effectiveOutputCap(ctx);
        const maxBytes = ctx.web?.fetch.maxBytes ?? MAX_BYTES;
        const contentType = res.headers.get("content-type") ?? "";
        const contentLength = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          await res.body?.cancel();
          return {
            ok: false,
            error: "OUTPUT_TRUNCATED: response too large",
          };
        }
        const earlyExitLimit =
          format === "html" || contentType.includes("text/html")
            ? 2 * cap
            : Number.POSITIVE_INFINITY;
        const body = await readBounded(res, maxBytes, earlyExitLimit);
        if (body.tooLarge) {
          return { ok: false, error: "OUTPUT_TRUNCATED: response too large" };
        }
        let output = convertBody(body.text, format, contentType);
        if (output.length > cap) {
          output = output.slice(0, cap) + "\nOUTPUT_TRUNCATED";
        }
        const cacheControl = res.headers.get("cache-control") ?? "";
        return {
          ok: true,
          content: output,
          noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl),
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
        };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    };

    if (freshness === "fast" && cached) {
      const age = Date.now() - cached.createdAt;
      if (age <= ttlMs) {
        return { toolCallId: call.id, name: "webfetch", content: cached.content };
      }
      if (age <= 10 * ttlMs && !refreshing.has(key)) {
        refreshing.add(key);
        void (async () => {
          try {
            const outcome = await fetchAndRender(cached);
            if (outcome.ok && outcome.notModified) cached.createdAt = Date.now();
            else if (outcome.ok && outcome.content && !outcome.noStore) {
              cachePut(key, {
                content: outcome.content,
                etag: outcome.etag,
                lastModified: outcome.lastModified,
                createdAt: Date.now(),
              });
            }
          } catch {
            // Background refresh failures never disturb the stale body.
          } finally {
            refreshing.delete(key);
          }
        })();
      }
      return { toolCallId: call.id, name: "webfetch", content: cached.content };
    }

    const outcome = await fetchAndRender(cached);
    if (!outcome.ok) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: outcome.error ?? "PROVIDER_CONNECTION_FAILED",
        isError: true,
      };
    }
    if (outcome.notModified && cached) {
      cached.createdAt = Date.now();
      return { toolCallId: call.id, name: "webfetch", content: cached.content };
    }
    const content = outcome.content ?? "";
    if (freshness !== "strict" && !outcome.noStore) {
      cachePut(key, {
        content,
        etag: outcome.etag,
        lastModified: outcome.lastModified,
        createdAt: Date.now(),
      });
    }
    return { toolCallId: call.id, name: "webfetch", content };
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
