#!/usr/bin/env node
/**
 * Time-to-first-token probe for streaming adapters. Non-gating.
 *
 * A local server emits the first delta immediately, then paces the rest so the
 * gap between first delta and completion is unmistakable. Run with:
 *   node scripts/bench-ttft.mjs
 */
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { GeminiAdapter } from "../dist/providers/gemini.js";
import { OpenAICompatibleAdapter } from "../dist/providers/openai-compatible.js";

const CHUNKS = 20;
const CHUNK_DELAY_MS = 20;
const request = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

async function withServer(kind, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (text, done) => {
      const payload =
        kind === "gemini"
          ? {
              candidates: [
                {
                  content: { parts: [{ text }] },
                  ...(done ? { finishReason: "STOP" } : {}),
                },
              ],
            }
          : { choices: [{ delta: { content: text } }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send("w", false);
    let i = 1;
    const tick = setInterval(() => {
      send("x", i === CHUNKS - 1);
      if (++i >= CHUNKS) {
        clearInterval(tick);
        if (kind === "openai") res.write("data: [DONE]\n\n");
        res.end();
      }
    }, CHUNK_DELAY_MS);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    // First call warms the HTTP connection pool; measure the second so cold
    // socket setup is not mistaken for adapter latency.
    await fn(port, false);
    return await fn(port, true);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function measure(adapter, label, _port, print = true) {
  const started = performance.now();
  let ttft;
  let text = "";
  for await (const event of adapter.stream(request)) {
    if (event.type === "text") {
      if (ttft === undefined) ttft = performance.now() - started;
      text += event.text;
    }
  }
  const total = performance.now() - started;
  if (print) {
    console.log(
      `${label.padEnd(20)} ttft ${ttft.toFixed(1).padStart(7)} ms   ` +
        `total ${total.toFixed(1).padStart(7)} ms   chars ${text.length}`,
    );
  }
  return { ttft, total };
}

const gemini = await withServer("gemini", (port, print) =>
  measure(
    new GeminiAdapter({
      id: "g",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "key",
    }),
    "gemini",
    port,
    print,
  ),
);
const openai = await withServer("openai", (port, print) =>
  measure(
    new OpenAICompatibleAdapter({
      id: "o",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
    }),
    "openai-compatible",
    port,
    print,
  ),
);

console.log(
  `\nfirst-delta gap: gemini ${(gemini.total - gemini.ttft).toFixed(1)} ms, ` +
    `openai ${(openai.total - openai.ttft).toFixed(1)} ms (paced body length)`,
);
