// webfetch tool: protocol guard, HTTP failure mapping, html->markdown
// conversion, output cap, and the response cache. All against a local HTTP
// server: no external network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { webfetchTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

let server: Server;
let hits = 0;
let base = "";
const routes = new Map<
  string,
  { body: string; type: string; status?: number }
>();

server = createServer((req, res) => {
  hits++;
  const route = routes.get(req.url ?? "/");
  if (!route) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(route.status ?? 200, { "content-type": route.type });
  res.end(route.body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const addr = server.address();
base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
after(() => server.close());

function ctx(): ToolContext {
  return { workspace: process.cwd(), signal: new AbortController().signal };
}

function webCtx(
  fetchOverrides: Record<string, unknown> = {},
): ToolContext {
  return {
    ...ctx(),
    web: {
      fetch: {
        cacheTtlSeconds: 300,
        maxBytes: 5_242_880,
        maxOutputChars: 30_000,
        extract: "auto",
        ...fetchOverrides,
      },
      search: {
        provider: "auto",
        maxResults: 8,
        cacheTtlSeconds: 120,
        fallback: true,
      },
    },
  } as any;
}

function call(args: Record<string, unknown>) {
  return { id: "1", name: "webfetch", arguments: args };
}

test("rejects non-http urls before any fetch", async () => {
  const r = await webfetchTool.execute(call({ url: "ftp://x" }), ctx());
  assert.match(r.content, /TOOL_ARGUMENT_INVALID: URL must start with/);
  assert.equal(r.isError, true);
});

test("maps HTTP failures to PROVIDER_INVALID_RESPONSE", async () => {
  routes.set("/gone", { body: "nope", type: "text/plain", status: 500 });
  const r = await webfetchTool.execute(call({ url: `${base}/gone` }), ctx());
  assert.match(r.content, /PROVIDER_INVALID_RESPONSE: 500/);
  assert.equal(r.isError, true);
});

test("404 is reported as an error", async () => {
  const r = await webfetchTool.execute(
    call({ url: `${base}/definitely-missing` }),
    ctx(),
  );
  assert.match(r.content, /PROVIDER_INVALID_RESPONSE: 404/);
});

test("plain text passes through as text", async () => {
  routes.set("/txt", { body: "hello world", type: "text/plain" });
  const r = await webfetchTool.execute(
    call({ url: `${base}/txt`, format: "text" }),
    ctx(),
  );
  assert.equal(r.content, "hello world");
  assert.ok(!r.isError);
});

test("html converts to markdown in markdown format", async () => {
  routes.set("/page", {
    body: "<html><head><title>t</title></head><body><h1>Heading</h1><p>Body text</p></body></html>",
    type: "text/html",
  });
  const r = await webfetchTool.execute(
    call({ url: `${base}/page`, format: "markdown" }),
    ctx(),
  );
  assert.match(r.content, /Heading/);
  assert.match(r.content, /Body text/);
  assert.ok(!/<h1>/.test(r.content));
});

test("html format returns the raw markup", async () => {
  routes.set("/raw", {
    body: "<p>keep tags</p>",
    type: "text/html",
  });
  const r = await webfetchTool.execute(
    call({ url: `${base}/raw`, format: "html" }),
    ctx(),
  );
  assert.match(r.content, /<p>keep tags<\/p>/);
});

test("cache serves repeats within the TTL without a new request", async () => {
  routes.set("/cached", { body: `cached-body`, type: "text/plain" });
  const before = hits;
  const first = await webfetchTool.execute(
    call({ url: `${base}/cached`, format: "text" }),
    ctx(),
  );
  const second = await webfetchTool.execute(
    call({ url: `${base}/cached`, format: "text" }),
    ctx(),
  );
  assert.equal(first.content, second.content);
  assert.equal(hits, before + 1, "second call served from cache");
});

test("oversized bodies are rejected with OUTPUT_TRUNCATED", async () => {
  routes.set("/huge", {
    body: "x".repeat(6 * 1024 * 1024),
    type: "text/plain",
  });
  const r = await webfetchTool.execute(
    call({ url: `${base}/huge`, format: "text" }),
    ctx(),
  );
  assert.match(r.content, /OUTPUT_TRUNCATED: response too large/);
  assert.equal(r.isError, true);
});

// Reason: ticket 02 — negotiated headers are observable at the local HTTP seam.
test("sends format-specific accept and language headers", async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>Heading</h1>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    for (const [path, format] of [
      ["/md", "markdown"],
      ["/txt", "text"],
      ["/raw", "html"],
    ] as const) {
      const r = await webfetchTool.execute(
        call({ url: `${srvBase}${path}`, format }),
        ctx(),
      );
      assert.ok(!r.isError);
    }
    assert.equal(seen.length, 3);
    assert.match(String(seen[0].accept), /^text\/markdown/);
    assert.match(String(seen[1].accept), /^text\/plain/);
    assert.match(String(seen[2].accept), /^text\/html/);
    for (const headers of seen) {
      assert.equal(headers["accept-language"], "en-US,en;q=0.9");
      assert.match(String(headers["user-agent"]), /atom-lite/);
    }
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// Reason: ticket 02 — the client cancels once useful text exceeds twice the output cap.
test("stops reading a large page after the useful-text threshold", async () => {
  let clientClosed = false;
  let tailWritten = false;
  let timer: NodeJS.Timeout | undefined;
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write(`<html><body><p>${"a".repeat(300)}</p>`);
    res.on("close", () => {
      clientClosed = true;
      if (timer) clearTimeout(timer);
    });
    timer = setTimeout(() => {
      res.write("<p>TAIL_MARKER</p></body></html>");
      res.end();
      tailWritten = true;
    }, 200);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const configured = {
    ...ctx(),
    web: {
      fetch: {
        cacheTtlSeconds: 300,
        maxBytes: 5_242_880,
        maxOutputChars: 100,
        extract: "full",
      },
      search: {
        provider: "auto",
        maxResults: 8,
        cacheTtlSeconds: 120,
        fallback: true,
      },
    },
  } as any;
  try {
    const r = await webfetchTool.execute(
      call({ url: `${srvBase}/stream` }),
      configured,
    );
    assert.ok(!r.isError);
    assert.ok(!r.content.includes("TAIL_MARKER"));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(clientClosed, true, "client cancelled the response stream");
    assert.equal(tailWritten, false, "tail chunk was never written");
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// Reason: ticket 01 — web config reaches the tool seam and controls the byte cap.
test("configured byte cap rejects a smaller response", async () => {
  routes.set("/small-cap", { body: "x".repeat(256), type: "text/plain" });
  const configured = {
    ...ctx(),
    web: {
      fetch: {
        cacheTtlSeconds: 300,
        maxBytes: 128,
        maxOutputChars: 30000,
        extract: "auto",
      },
      search: {
        provider: "auto",
        maxResults: 8,
        cacheTtlSeconds: 120,
        fallback: true,
      },
    },
  } as any;
  const r = await webfetchTool.execute(
    call({ url: `${base}/small-cap`, format: "text" }),
    configured,
  );
  assert.match(r.content, /OUTPUT_TRUNCATED: response too large/);
  assert.equal(r.isError, true);
});

// Reason: ticket 03 — fresh mode revalidates with a validator and reuses the body on 304.
test("fresh mode revalidates with etag and reuses the cached body", async () => {
  let hits = 0;
  let conditional = false;
  const srv = createServer((req, res) => {
    hits++;
    if (req.headers["if-none-match"] === '"v1"') {
      conditional = true;
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", etag: '"v1"' });
    res.end("body-v1");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const first = await webfetchTool.execute(
      call({ url: `${srvBase}/etag`, format: "text" }),
      webCtx(),
    );
    const second = await webfetchTool.execute(
      call({ url: `${srvBase}/etag`, format: "text", freshness: "fresh" }),
      webCtx(),
    );
    assert.equal(first.content, "body-v1");
    assert.equal(second.content, "body-v1");
    assert.equal(conditional, true);
    assert.equal(hits, 2);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// Reason: ticket 03 — strict mode neither reads nor writes the cache.
test("strict mode bypasses and never populates the cache", async () => {
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`body-${hits}`);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const url = `${srvBase}/strict`;
    const first = await webfetchTool.execute(
      call({ url, format: "text", freshness: "strict" }),
      webCtx(),
    );
    const second = await webfetchTool.execute(
      call({ url, format: "text", freshness: "strict" }),
      webCtx(),
    );
    assert.equal(first.content, "body-1");
    assert.equal(second.content, "body-2");
    assert.equal(hits, 2);
    const third = await webfetchTool.execute(
      call({ url, format: "text" }),
      webCtx(),
    );
    assert.equal(third.content, "body-3");
    assert.equal(hits, 3);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// Reason: ticket 03 — no-store responses are never cached.
test("no-store responses are fetched on every call", async () => {
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    res.end(`body-${hits}`);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const url = `${srvBase}/no-store`;
    const first = await webfetchTool.execute(
      call({ url, format: "text" }),
      webCtx(),
    );
    const second = await webfetchTool.execute(
      call({ url, format: "text" }),
      webCtx(),
    );
    assert.equal(first.content, "body-1");
    assert.equal(second.content, "body-2");
    assert.equal(hits, 2);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// Reason: ticket 03 — fast mode serves stale content and refreshes in background.
test("fast mode serves stale content and refreshes in the background", async () => {
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`body-${hits}`);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const srvBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const url = `${srvBase}/stale`;
    const shortTtl = webCtx({ cacheTtlSeconds: 1 });
    const first = await webfetchTool.execute(
      call({ url, format: "text" }),
      shortTtl,
    );
    assert.equal(first.content, "body-1");
    await new Promise<void>((r) => setTimeout(r, 1100));
    const stale = await webfetchTool.execute(
      call({ url, format: "text" }),
      shortTtl,
    );
    assert.equal(stale.content, "body-1");
    await new Promise<void>((r) => setTimeout(r, 100));
    assert.ok(hits >= 2, "background refresh ran");
    const after = await webfetchTool.execute(
      call({ url, format: "text" }),
      shortTtl,
    );
    assert.equal(after.content, "body-2");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
