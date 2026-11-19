import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { websearchTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

let server: Server;
let base = "";
let fixture = "";

server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(fixture);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const addr = server.address();
base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  if (raw.startsWith("https://html.duckduckgo.com/")) {
    return originalFetch(raw.replace("https://html.duckduckgo.com", base), init);
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = originalFetch;
  server.close();
});

function ctx(maxResults = 8): ToolContext {
  return {
    workspace: process.cwd(),
    signal: new AbortController().signal,
    web: {
      fetch: {
        cacheTtlSeconds: 300,
        maxBytes: 5_242_880,
        maxOutputChars: 30_000,
        extract: "auto",
      },
      search: {
        provider: "ddg",
        maxResults,
        cacheTtlSeconds: 120,
        fallback: true,
      },
    },
  } as any;
}

function call(args: Record<string, unknown>) {
  return { id: "1", name: "websearch", arguments: args };
}

function result(title: string, target: string, snippet: string): string {
  const uddg = encodeURIComponent(target);
  return `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${uddg}&amp;rut=x">${title}</a><a class="result__snippet">${snippet}</a></div>`;
}

// Reason: ticket 06 — results are parsed from HTML and exposed in both channels.
test("parses DuckDuckGo results into text and structured content", async () => {
  fixture = `<html><body>${result("Alpha", "https://example.com/a", "alpha snippet")}${result("Beta", "https://example.org/b", "beta snippet")}</body></html>`;
  const r = await websearchTool.execute(call({ query: "alpha beta" }), ctx());
  assert.match(r.content, /Alpha/);
  assert.match(r.content, /https:\/\/example\.com\/a/);
  assert.match(r.content, /alpha snippet/);
  const structured = (r as any).structuredContent as any[];
  assert.equal(structured.length, 2);
  assert.deepEqual(structured[0], {
    title: "Alpha",
    url: "https://example.com/a",
    content: "alpha snippet",
  });
});

// Reason: ticket 06 — canonical dedupe removes mirrored results.
test("deduplicates the same destination with tracking parameters", async () => {
  fixture = `<html><body>${result("First", "https://example.com/a?utm_source=x", "first")}${result("Second", "https://example.com/a?utm_source=y", "second")}</body></html>`;
  const r = await websearchTool.execute(call({ query: "dup" }), ctx());
  const structured = (r as any).structuredContent as any[];
  assert.equal(structured.length, 1);
  assert.equal(structured[0].title, "First");
});

// Reason: ticket 06 — ranking is deterministic and term-aware.
test("ranks term matches ahead of unrelated results deterministically", async () => {
  fixture = `<html><body>${result("Unrelated", "https://example.com/z", "nothing here")}${result("Wanted term", "https://example.com/w", "the wanted term appears")}</body></html>`;
  const first = await websearchTool.execute(call({ query: "wanted term" }), ctx());
  const second = await websearchTool.execute(call({ query: "wanted term" }), ctx());
  assert.equal(first.content, second.content);
  const structured = (first as any).structuredContent as any[];
  assert.equal(structured[0].title, "Wanted term");
});

// Reason: ticket 06 — config supplies the default count and clamps an explicit one.
test("config maxResults is the default and an upper bound", async () => {
  fixture = `<html><body>${result("A", "https://example.com/a", "a")}${result("B", "https://example.com/b", "b")}${result("C", "https://example.com/c", "c")}</body></html>`;
  const limited = await websearchTool.execute(
    call({ query: "abc", num_results: 9 }),
    ctx(2),
  );
  const structured = (limited as any).structuredContent as any[];
  assert.equal(structured.length, 2);
  const defaulted = await websearchTool.execute(call({ query: "abc" }), ctx(2));
  assert.equal(((defaulted as any).structuredContent as any[]).length, 2);
});

// Reason: ticket 06 — an empty parse keeps the existing no-results message.
test("reports an explicit no-results message", async () => {
  fixture = "<html><body></body></html>";
  const r = await websearchTool.execute(call({ query: "nothing" }), ctx());
  assert.equal(r.content, "No results found.");
});
