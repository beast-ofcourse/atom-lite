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
