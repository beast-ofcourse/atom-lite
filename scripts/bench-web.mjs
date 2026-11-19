import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { webfetchTool, websearchTool } from "../dist/tools/index.js";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const baselineIndex = args.indexOf("--baseline");
const outPath = outIndex >= 0 ? args[outIndex + 1] : "scripts/bench-web.results.json";
const baselinePath = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;

const boilerplate = "<nav>" + "navigation ".repeat(20_000) + "</nav>";
const main = "<main><h1>Answer</h1><p>" + "useful content ".repeat(400) + "</p></main>";
const fixtures = {
  "/large": {
    body: `<html><body>${boilerplate}${main}</body></html>`,
    type: "text/html",
  },
  "/text": {
    body: "plain text line\n".repeat(8_000),
    type: "text/plain",
  },
  "/search": {
    body: `<html><body>${Array.from({ length: 20 }, (_, i) =>
      `<div class="result"><a class="result__a" href="https://example.com/${i}">Result ${i} bench query</a><a class="result__snippet">bench query snippet ${i}</a></div>`,
    ).join("")}</body></html>`,
    type: "text/html",
  },
};

let bytesServed = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const fixture = fixtures[path];
  if (!fixture) {
    res.writeHead(404);
    res.end();
    return;
  }
  bytesServed += Buffer.byteLength(fixture.body);
  res.writeHead(200, { "content-type": fixture.type });
  res.end(fixture.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (raw.startsWith("https://html.duckduckgo.com/html")) {
    const rewritten = raw
      .replace("https://html.duckduckgo.com/html", `${base}/search`)
      .replace("/search/", "/search");
    return originalFetch(rewritten, init);
  }
  return originalFetch(input, init);
});

const ctx = {
  workspace: process.cwd(),
  signal: new AbortController().signal,
  maxToolOutputBytes: 2_000_000,
  web: {
    fetch: {
      cacheTtlSeconds: 300,
      maxBytes: 5_242_880,
      maxOutputChars: 2_000_000,
      extract: "auto",
    },
    search: {
      provider: "ddg",
      maxResults: 20,
      cacheTtlSeconds: 120,
      fallback: true,
    },
  },
};

const iterations = 12;
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
    p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
  };
};

const cases = [
  {
    name: "fetch large HTML",
    run: () =>
      webfetchTool.execute(
        {
          id: "bench-html",
          name: "webfetch",
          arguments: { url: `${base}/large`, freshness: "strict" },
        },
        ctx,
      ),
  },
  {
    name: "fetch plain text",
    run: () =>
      webfetchTool.execute(
        {
          id: "bench-text",
          name: "webfetch",
          arguments: { url: `${base}/text`, format: "text", freshness: "strict" },
        },
        ctx,
      ),
  },
  {
    name: "search results",
    run: () =>
      websearchTool.execute(
        {
          id: "bench-search",
          name: "websearch",
          arguments: { query: "bench query", freshness: "strict" },
        },
        ctx,
      ),
  },
];

const results = [];
try {
  for (const benchCase of cases) {
    for (let i = 0; i < 2; i++) await benchCase.run();
    const samples = [];
    const before = bytesServed;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await benchCase.run();
      samples.push(performance.now() - start);
    }
    results.push({
      name: benchCase.name,
      iterations,
      bytesServed: bytesServed - before,
      ...percentiles(samples),
    });
  }
} finally {
  globalThis.fetch = originalFetch;
  server.close();
}

const report = { generatedAt: new Date().toISOString(), cases: results };
if (baselinePath && existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  report.baseline = baselinePath;
  report.cases = results.map((current) => {
    const old = baseline.cases?.find((entry) => entry.name === current.name);
    if (!old) return current;
    return {
      ...current,
      baselineP50Ms: old.p50Ms,
      baselineP95Ms: old.p95Ms,
      p50DeltaPercent: Number(
        (((current.p50Ms - old.p50Ms) / old.p50Ms) * 100).toFixed(1),
      ),
    };
  });
}

writeFileSync(resolve(outPath), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
