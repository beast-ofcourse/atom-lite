import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DomUtils, parseDocument, Parser } from "htmlparser2";
import TurndownService from "turndown";
import { userCacheDir } from "../config/paths.js";
import { resolveToolPermission } from "../agents/permissions.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

type Format = "text" | "markdown" | "html";
type Freshness = "fast" | "fresh" | "strict";
type ExtractMode = "auto" | "main" | "full";

const ArgsSchema = z
  .object({
    url: z.string(),
    format: z.enum(["text", "markdown", "html"]).optional(),
    timeout: z.number().int().positive().optional(),
    freshness: z.enum(["fast", "fresh", "strict"]).optional(),
    extract: z.enum(["auto", "main", "full"]).optional(),
  })
  .strict();

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;
const CACHE_MAX_ENTRIES = 64;
const ARTIFACT_MAX_ENTRIES = 32;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const MAIN_TEXT_MIN = 200;

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
  contentType?: string;
  title?: string;
  description?: string;
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

/** Validate a fetch URL and strip its fragment, which is never sent. */
function validateFetchUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  parsed.hash = "";
  return parsed.href;
}

/** Re-check persona policy for a hop, since a redirect can change the resource. */
function permissionErrorFor(ctx: ToolContext, url: string): string | undefined {
  const match = resolveToolPermission(ctx.agentPermissions, "webfetch", url);
  if (!match || match.decision === "allow") return undefined;
  return `PERSONA_PERMISSION_DENIED: webfetch matched "${match.pattern}"`;
}

function effectiveOutputCap(ctx: ToolContext): number {
  return Math.min(
    ctx.web?.fetch.maxOutputChars ?? 30_000,
    ctx.maxToolOutputBytes ?? 30_000,
  );
}

/** Read only as much of the response as needed, cancelling on either limit. */
async function readBounded(
  res: Response,
  maxBytes: number,
  usefulTextLimit: number,
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

function isHtmlResponse(contentType: string, text?: string): boolean {
  return (
    contentType.includes("text/html") ||
    (text !== undefined && text.trim().startsWith("<"))
  );
}

function extractMainHtml(html: string, mode: ExtractMode): string | undefined {
  if (mode === "full") return undefined;
  const doc = parseDocument(html);
  const nodes = DomUtils.getElementsByTagName(
    (name) => name === "main" || name === "article",
    doc.children,
    true,
  );
  const node = nodes[0];
  if (!node) return undefined;
  if (
    mode === "auto" &&
    DomUtils.textContent(node).trim().length < MAIN_TEXT_MIN
  )
    return undefined;
  return DomUtils.getInnerHTML(node);
}

function extractMetadata(html: string): {
  title?: string;
  description?: string;
} {
  const doc = parseDocument(html);
  const titleNode = DomUtils.getElementsByTagName("title", doc.children, true)[0];
  const title = titleNode ? DomUtils.textContent(titleNode).trim() : "";
  const metas = DomUtils.getElementsByTagName("meta", doc.children, true);
  const descriptionNode = metas.find(
    (node) =>
      DomUtils.getAttributeValue(node, "name")?.toLowerCase() === "description",
  );
  const description = descriptionNode
    ? DomUtils.getAttributeValue(descriptionNode, "content")?.trim()
    : undefined;
  return {
    title: title || undefined,
    description: description || undefined,
  };
}

function convertBody(
  text: string,
  format: Format,
  contentType: string,
  extract: ExtractMode,
): string {
  const isHtml = isHtmlResponse(contentType, text);
  if (format === "html" || !isHtml) return text;
  const selected = extractMainHtml(text, extract) ?? text;
  if (format === "markdown") {
    try {
      return turndown.turndown(selected);
    } catch {
      return stripHtml(selected);
    }
  }
  return stripHtml(selected);
}

/** Remove expired artifacts and keep the directory bounded. */
function pruneArtifacts(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    const now = Date.now();
    const entries = readdirSync(dir)
      .map((name) => {
        try {
          return { path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is { path: string; mtime: number } => !!entry)
      .sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (now - entry.mtime > ARTIFACT_TTL_MS) {
        try {
          unlinkSync(entry.path);
        } catch {
          // Best effort cleanup.
        }
      }
    }
    const survivors = entries.filter(
      (entry) => now - entry.mtime <= ARTIFACT_TTL_MS,
    );
    while (survivors.length >= ARTIFACT_MAX_ENTRIES) {
      const oldest = survivors.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
      } catch {
        break;
      }
    }
  } catch {
    // Cleanup must never block a fetch.
  }
}

/** Write oversized output as a bounded artifact, never reused as a cache. */
function writeArtifact(
  content: string,
  id: string,
  url: string,
  format: Format,
): string {
  const dir = join(userCacheDir(), "web-output");
  mkdirSync(dir, { recursive: true });
  pruneArtifacts(dir);
  const hash = createHash("sha256")
    .update(`${url}\n${format}`)
    .digest("hex")
    .slice(0, 16);
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `${safeId}-${hash}.txt`);
  writeFileSync(path, content, "utf8");
  return path;
}

try {
  pruneArtifacts(join(userCacheDir(), "web-output"));
} catch {
  // Startup cleanup is best effort.
}

interface FetchOutcome {
  ok: boolean;
  content?: string;
  preview?: string;
  artifactPath?: string;
  contentType?: string;
  title?: string;
  description?: string;
  notModified?: boolean;
  noStore?: boolean;
  etag?: string;
  lastModified?: string;
  error?: string;
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
        extract: { type: "string", enum: ["auto", "main", "full"] },
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
    const extract = parsed.data.extract ?? ctx.web?.fetch.extract ?? "auto";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content:
          "TOOL_ARGUMENT_INVALID: URL must start with http:// or https://",
        isError: true,
      };
    }
    const target = validateFetchUrl(url);
    if (!target) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: "TOOL_ARGUMENT_INVALID: URL must not include credentials",
        isError: true,
      };
    }
    const key = cacheKey(target, format);
    const ttlMs = (ctx.web?.fetch.cacheTtlSeconds ?? 300) * 1000;
    const cached = freshness === "strict" ? undefined : fetchCache.get(key);
    const cachedResult = (): ToolResult => ({
      toolCallId: call.id,
      name: "webfetch",
      content: cached?.content ?? "",
      structuredContent: {
        contentType: cached?.contentType,
        title: cached?.title,
        description: cached?.description,
        truncated: false,
      },
    });

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
        let current = target;
        let hops = 0;
        for (;;) {
          let response: Response;
          try {
            response = await fetch(current, {
              headers: { ...headers },
              signal: controller.signal,
              redirect: "manual",
            });
            if (response.status === 403) {
              await response.body?.cancel();
              try {
                response = await fetch(current, {
                  headers: requestHeaders(format, "atom-lite/0.1 (compatible)"),
                  signal: controller.signal,
                  redirect: "manual",
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
          const location = response.headers.get("location");
          if (
            location &&
            [301, 302, 303, 307, 308].includes(response.status)
          ) {
            await response.body?.cancel();
            if (hops >= 5) {
              return {
                ok: false,
                error: "PROVIDER_INVALID_RESPONSE: too many redirects",
              };
            }
            let nextHref: string;
            try {
              nextHref = new URL(location, current).href;
            } catch {
              return {
                ok: false,
                error: "TOOL_ARGUMENT_INVALID: invalid redirect target",
              };
            }
            const next = validateFetchUrl(nextHref);
            if (!next) {
              return {
                ok: false,
                error:
                  "TOOL_ARGUMENT_INVALID: redirect target must be http(s) without credentials",
              };
            }
            const denied = permissionErrorFor(ctx, next);
            if (denied) return { ok: false, error: denied };
            current = next;
            hops++;
            continue;
          }
          res = response;
          break;
        }
        if (res.status === 304) {
          return {
            ok: true,
            notModified: true,
            etag: res.headers.get("etag") ?? undefined,
            lastModified: res.headers.get("last-modified") ?? undefined,
          };
        }
        if (!res.ok) {
          return { ok: false, error: `PROVIDER_INVALID_RESPONSE: ${res.status}` };
        }
        const cap = effectiveOutputCap(ctx);
        const maxBytes = ctx.web?.fetch.maxBytes ?? MAX_BYTES;
        const contentType = res.headers.get("content-type") ?? "";
        const rawLength = res.headers.get("content-length");
        const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          await res.body?.cancel();
          return { ok: false, error: "OUTPUT_TRUNCATED: response too large" };
        }
        const canEarlyExit =
          isHtmlResponse(contentType) ||
          (Number.isFinite(contentLength) && contentLength <= maxBytes);
        const earlyExitLimit = canEarlyExit ? 2 * cap : Number.POSITIVE_INFINITY;
        const body = await readBounded(res, maxBytes, earlyExitLimit);
        if (body.tooLarge) {
          return { ok: false, error: "OUTPUT_TRUNCATED: response too large" };
        }
        const metadata = isHtmlResponse(contentType, body.text)
          ? extractMetadata(body.text)
          : {};
        const output = convertBody(body.text, format, contentType, extract);
        const cacheControl = res.headers.get("cache-control") ?? "";
        const base = {
          ok: true as const,
          contentType,
          title: metadata.title,
          description: metadata.description,
          noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl),
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
        };
        if (output.length > cap) {
          try {
            const path = writeArtifact(output, call.id, target, format);
            return {
              ...base,
              preview: output.slice(0, cap),
              artifactPath: path,
            };
          } catch {
            return {
              ...base,
              content: output.slice(0, cap) + "\nOUTPUT_TRUNCATED",
            };
          }
        }
        return { ...base, content: output };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    };

    const refreshMetadata = (outcome: FetchOutcome): void => {
      if (!cached) return;
      cached.createdAt = Date.now();
      if (outcome.etag) cached.etag = outcome.etag;
      if (outcome.lastModified) cached.lastModified = outcome.lastModified;
    };

    if (freshness === "fast" && cached) {
      const age = Date.now() - cached.createdAt;
      if (age <= ttlMs) {
        return cachedResult();
      }
      if (age <= 10 * ttlMs) {
        if (!refreshing.has(key)) {
          refreshing.add(key);
          void (async () => {
            try {
              const outcome = await fetchAndRender(cached);
              if (outcome.ok && outcome.notModified) refreshMetadata(outcome);
              else if (outcome.ok && outcome.content && !outcome.noStore) {
                cachePut(key, {
                  content: outcome.content,
                  contentType: outcome.contentType,
                  title: outcome.title,
                  description: outcome.description,
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
        return cachedResult();
      }
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
      refreshMetadata(outcome);
      return cachedResult();
    }
    const structuredContent = {
      contentType: outcome.contentType,
      title: outcome.title,
      description: outcome.description,
      truncated: !!outcome.artifactPath,
      ...(outcome.artifactPath ? { outputPath: outcome.artifactPath } : {}),
    };
    if (outcome.artifactPath) {
      return {
        toolCallId: call.id,
        name: "webfetch",
        content: `${outcome.preview ?? ""}\nOUTPUT_TRUNCATED: full output at ${outcome.artifactPath}`,
        structuredContent,
      };
    }
    const content = outcome.content ?? "";
    if (freshness !== "strict" && !outcome.noStore) {
      cachePut(key, {
        content,
        contentType: outcome.contentType,
        title: outcome.title,
        description: outcome.description,
        etag: outcome.etag,
        lastModified: outcome.lastModified,
        createdAt: Date.now(),
      });
    }
    return { toolCallId: call.id, name: "webfetch", content, structuredContent };
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
