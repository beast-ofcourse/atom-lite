import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { websearchTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

let server: Server;
let base = "";
let fixture = "";
let searchHits = 0;
const providerResponses = new Map<
  string,
  { status: number; body: string; headers?: Record<string, string> }
>();
const providerHits = new Map<string, number>();

server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", base).pathname;
  providerHits.set(path, (providerHits.get(path) ?? 0) + 1);
  const configured = providerResponses.get(path);
  if (configured) {
    res.writeHead(configured.status, {
      "content-type": "application/json",
      ...(configured.headers ?? {}),
    });
    res.end(configured.body);
    return;
  }
  searchHits++;
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
  const routes: [string, string][] = [
    ["https://html.duckduckgo.com/html", "/ddg"],
    ["https://api.tavily.com/search", "/tavily"],
    ["https://api.search.brave.com/res/v1/web/search", "/brave"],
    ["https://api.exa.ai/search", "/exa"],
    ["https://google.serper.dev/search", "/serper"],
  ];
  for (const [prefix, path] of routes) {
    if (raw.startsWith(prefix)) {
      return originalFetch(base + path + raw.slice(prefix.length), init);
    }
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = originalFetch;
  server.close();
});

function ctx(
  maxResults = 8,
  cacheTtlSeconds = 120,
  searchOverrides: Record<string, unknown> = {},
): ToolContext {
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
        cacheTtlSeconds,
        fallback: true,
        ...searchOverrides,
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

const API_KEYS = [
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
  "EXA_API_KEY",
  "SERPER_API_KEY",
] as const;

async function withEnv(
  values: Partial<Record<(typeof API_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = API_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of API_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function setProviderResponse(
  path: string,
  status: number,
  body: string,
  headers?: Record<string, string>,
): void {
  providerResponses.set(path, { status, body, headers });
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

// Reason: ticket 07 — a repeated search is served from the in-memory cache.
test("cache serves a repeated search without a new request", async () => {
  fixture = `<html><body>${result("Cached", "https://example.com/cached", "cached snippet")}</body></html>`;
  const before = searchHits;
  const first = await websearchTool.execute(
    call({ query: "cache-hit-unique" }),
    ctx(),
  );
  const second = await websearchTool.execute(
    call({ query: "cache-hit-unique" }),
    ctx(),
  );
  assert.equal(first.content, second.content);
  assert.equal(searchHits, before + 1);
});

// Reason: ticket 07 — strict mode never reads or writes the search cache.
test("strict search bypasses the cache", async () => {
  fixture = `<html><body>${result("Strict", "https://example.com/strict", "strict")}</body></html>`;
  const before = searchHits;
  await websearchTool.execute(
    call({ query: "strict-unique", freshness: "strict" }),
    ctx(),
  );
  await websearchTool.execute(
    call({ query: "strict-unique", freshness: "strict" }),
    ctx(),
  );
  assert.equal(searchHits, before + 2);
});

// Reason: ticket 07 — fresh search re-queries instead of using the cache.
test("fresh search re-queries and sees a changed fixture", async () => {
  fixture = `<html><body>${result("Old", "https://example.com/old", "old")}</body></html>`;
  await websearchTool.execute(call({ query: "fresh-unique" }), ctx());
  fixture = `<html><body>${result("New", "https://example.com/new", "new")}</body></html>`;
  const r = await websearchTool.execute(
    call({ query: "fresh-unique", freshness: "fresh" }),
    ctx(),
  );
  assert.match(r.content, /New/);
  assert.doesNotMatch(r.content, /Old/);
});

// Reason: ticket 07 — fast mode serves stale results and refreshes in background.
test("fast search serves stale results and refreshes in the background", async () => {
  fixture = `<html><body>${result("First", "https://example.com/first", "first")}</body></html>`;
  const shortTtl = ctx(8, 1);
  await websearchTool.execute(call({ query: "stale-search-unique" }), shortTtl);
  await new Promise<void>((r) => setTimeout(r, 1100));
  fixture = `<html><body>${result("Second", "https://example.com/second", "second")}</body></html>`;
  const stale = await websearchTool.execute(
    call({ query: "stale-search-unique" }),
    shortTtl,
  );
  assert.match(stale.content, /First/);
  await new Promise<void>((r) => setTimeout(r, 100));
  const after = await websearchTool.execute(
    call({ query: "stale-search-unique" }),
    shortTtl,
  );
  assert.match(after.content, /Second/);
});

// Reason: ticket 08 — automatic selection uses configured keys in priority order.
test("automatic provider selection prefers Tavily when keys exist", async () => {
  await withEnv(
    {
      TAVILY_API_KEY: "tavily-key",
      BRAVE_API_KEY: "brave-key",
      EXA_API_KEY: "exa-key",
      SERPER_API_KEY: "serper-key",
    },
    async () => {
      setProviderResponse(
        "/tavily",
        200,
        JSON.stringify({
          results: [
            {
              title: "Tavily result",
              url: "https://tavily.example/a",
              content: "tavily snippet",
            },
          ],
        }),
      );
      const r = await websearchTool.execute(
        call({ query: "auto-provider-unique", freshness: "strict" }),
        ctx(8, 120, { provider: "auto" }),
      );
      assert.match(r.content, /Tavily result/);
    },
  );
});

// Reason: ticket 08 — an explicit provider wins over other configured keys.
test("an explicit provider wins provider selection", async () => {
  await withEnv({ TAVILY_API_KEY: "tavily-key", BRAVE_API_KEY: "brave-key" }, async () => {
    setProviderResponse(
      "/tavily",
      200,
      JSON.stringify({
        results: [
          { title: "Tavily result", url: "https://tavily.example/a", content: "x" },
        ],
      }),
    );
    setProviderResponse(
      "/brave",
      200,
      JSON.stringify({
        web: {
          results: [
            {
              title: "Brave result",
              url: "https://brave.example/b",
              description: "brave snippet",
            },
          ],
        },
      }),
    );
    const r = await websearchTool.execute(
      call({ query: "explicit-provider-unique", freshness: "strict" }),
      ctx(8, 120, { provider: "brave" }),
    );
    assert.match(r.content, /Brave result/);
  });
});

// Reason: ticket 08 — fallback false fails with the selected provider only.
test("fallback false reports provider failure without DuckDuckGo", async () => {
  const before = searchHits;
  await withEnv({ SERPER_API_KEY: "serper-key" }, async () => {
    setProviderResponse("/serper", 500, "failure");
    const r = await websearchTool.execute(
      call({ query: "no-fallback-unique", freshness: "strict" }),
      ctx(8, 120, { provider: "serper", fallback: false }),
    );
    assert.equal(r.content, "WEBSEARCH_PROVIDER_UNAVAILABLE");
    assert.equal(r.isError, true);
  });
  assert.equal(searchHits, before);
});

// Reason: ticket 08 — rate-limit errors never expose API credentials.
test("rate-limit errors omit the credential", async () => {
  await withEnv({ TAVILY_API_KEY: "super-secret-key" }, async () => {
    setProviderResponse("/tavily", 429, "rate limited", {
      "retry-after": "60",
    });
    const r = await websearchTool.execute(
      call({ query: "rate-limit-unique", freshness: "strict" }),
      ctx(8, 120, { provider: "tavily", fallback: false }),
    );
    assert.equal(r.content, "WEBSEARCH_PROVIDER_RATE_LIMITED");
    assert.ok(!r.content.includes("super-secret-key"));
  });
});

// Reason: ticket 08 — a failed provider enters cooldown and is skipped later.
test("a failed provider enters cooldown and is skipped", async () => {
  await withEnv(
    { EXA_API_KEY: "exa-key", BRAVE_API_KEY: "brave-key" },
    async () => {
      setProviderResponse("/exa", 500, "failure");
      setProviderResponse(
        "/brave",
        200,
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://brave.example/b",
                description: "brave snippet",
              },
            ],
          },
        }),
      );
      const first = await websearchTool.execute(
        call({ query: "failed-cooldown-unique", freshness: "strict" }),
        ctx(8, 120, { provider: "exa" }),
      );
      assert.match(first.content, /Brave result/);
      const afterFirst = providerHits.get("/exa") ?? 0;
      const second = await websearchTool.execute(
        call({ query: "failed-cooldown-unique", freshness: "strict" }),
        ctx(8, 120, { provider: "exa" }),
      );
      assert.match(second.content, /Brave result/);
      assert.equal(providerHits.get("/exa") ?? 0, afterFirst);
    },
  );
});

// Reason: ticket 08 — a rate-limited provider is cooled down and skipped later.
test("a rate-limited provider enters cooldown and is skipped", async () => {
  fixture = `<html><body>${result("DDG fallback", "https://ddg.example/f", "ddg")}</body></html>`;
  await withEnv({ BRAVE_API_KEY: "brave-key" }, async () => {
    setProviderResponse("/brave", 429, "rate limited", {
      "retry-after": "60",
    });
    const braveBefore = providerHits.get("/brave") ?? 0;
    const first = await websearchTool.execute(
      call({ query: "cooldown-unique", freshness: "strict" }),
      ctx(8, 120, { provider: "brave" }),
    );
    assert.match(first.content, /DDG fallback/);
    const afterFirst = providerHits.get("/brave") ?? 0;
    const second = await websearchTool.execute(
      call({ query: "cooldown-unique", freshness: "strict" }),
      ctx(8, 120, { provider: "brave" }),
    );
    assert.match(second.content, /DDG fallback/);
    assert.equal(providerHits.get("/brave") ?? 0, afterFirst);
    assert.equal(afterFirst, braveBefore + 1);
  });
});
