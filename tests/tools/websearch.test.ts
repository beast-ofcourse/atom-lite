import { test } from "node:test";
import assert from "node:assert/strict";
import { websearchTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

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

function withFetch(html: string, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// Reason: ticket 06 — results are parsed from HTML and exposed in both channels.
test("parses DuckDuckGo results into text and structured content", async () => {
  const html = `<html><body>${result("Alpha", "https://example.com/a", "alpha snippet")}${result("Beta", "https://example.org/b", "beta snippet")}</body></html>`;
  await withFetch(html, async () => {
    const r = await websearchTool.execute(
      call({ query: "alpha beta" }),
      ctx(),
    );
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
});

// Reason: ticket 06 — canonical dedupe removes mirrored results.
test("deduplicates the same destination with tracking parameters", async () => {
  const html = `<html><body>${result("First", "https://example.com/a?utm_source=x", "first")}${result("Second", "https://example.com/a?utm_source=y", "second")}</body></html>`;
  await withFetch(html, async () => {
    const r = await websearchTool.execute(call({ query: "dup" }), ctx());
    const structured = (r as any).structuredContent as any[];
    assert.equal(structured.length, 1);
    assert.equal(structured[0].title, "First");
  });
});

// Reason: ticket 06 — ranking is deterministic and term-aware.
test("ranks term matches ahead of unrelated results deterministically", async () => {
  const html = `<html><body>${result("Unrelated", "https://example.com/z", "nothing here")}${result("Wanted term", "https://example.com/w", "the wanted term appears")}</body></html>`;
  await withFetch(html, async () => {
    const first = await websearchTool.execute(
      call({ query: "wanted term" }),
      ctx(),
    );
    const second = await websearchTool.execute(
      call({ query: "wanted term" }),
      ctx(),
    );
    assert.equal(first.content, second.content);
    const structured = (first as any).structuredContent as any[];
    assert.equal(structured[0].title, "Wanted term");
  });
});

// Reason: ticket 06 — config supplies the default count and clamps an explicit one.
test("config maxResults is the default and an upper bound", async () => {
  const html = `<html><body>${result("A", "https://example.com/a", "a")}${result("B", "https://example.com/b", "b")}${result("C", "https://example.com/c", "c")}</body></html>`;
  await withFetch(html, async () => {
    const limited = await websearchTool.execute(
      call({ query: "abc", num_results: 9 }),
      ctx(2),
    );
    const structured = (limited as any).structuredContent as any[];
    assert.equal(structured.length, 2);
    const defaulted = await websearchTool.execute(
      call({ query: "abc" }),
      ctx(2),
    );
    assert.equal(
      ((defaulted as any).structuredContent as any[]).length,
      2,
    );
  });
});

// Reason: ticket 06 — an empty parse keeps the existing no-results message.
test("reports an explicit no-results message", async () => {
  await withFetch("<html><body></body></html>", async () => {
    const r = await websearchTool.execute(call({ query: "nothing" }), ctx());
    assert.equal(r.content, "No results found.");
  });
});
