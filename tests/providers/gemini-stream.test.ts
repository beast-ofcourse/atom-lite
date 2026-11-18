import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GeminiAdapter } from "../../dist/providers/gemini.js";
import type { ModelRequest } from "../../dist/types.js";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const request: ModelRequest = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

test("Gemini emits the first text delta before the response finishes (TTFT)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seenUrl = "";
  await withServer(
    (req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"candidates":[{"content":{"parts":[{"text":"first"}]}}]}\n\n',
      );
      void gate.then(() => {
        res.write(
          'data: {"candidates":[{"content":{"parts":[{"text":" second"}]},"finishReason":"STOP"}],' +
            '"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n',
        );
        res.end();
      });
    },
    async (port) => {
      const adapter = new GeminiAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
        apiKey: "key",
      });
      const iterator = adapter.stream(request)[Symbol.asyncIterator]();
      // With buffered generate(), this cannot resolve until the gate opens.
      const first = await withTimeout(iterator.next(), 1000);
      assert.deepEqual(first.value, { type: "text", text: "first" });
      release();

      const events = [first.value!];
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        events.push(event);
      }
      const text = events
        .filter((e) => e.type === "text")
        .map((e: any) => e.text)
        .join("");
      assert.equal(text, "first second");
      const done: any = events.find((e) => e.type === "done");
      assert.ok(done, "emits a done event");
      assert.deepEqual(done.response.usage, {
        input: 10,
        output: 2,
        total: 12,
      });
      assert.match(seenUrl, /:streamGenerateContent/);
      assert.match(seenUrl, /alt=sse/);
    },
  );
});

test("Gemini streams thinking parts immediately and keeps tool calls in done", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"candidates":[{"content":{"parts":[{"text":"planning","thought":true}]}}]}\n\n' +
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"}}}]}}],"finishReason":"STOP_PAYLOAD"}\n\n' +
          "data: [DONE]\n\n",
      );
      res.end();
    },
    async (port) => {
      const adapter = new GeminiAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
        apiKey: "key",
      });
      const events = [];
      for await (const event of adapter.stream(request)) events.push(event);
      assert.deepEqual(events[0], { type: "thinking", text: "planning" });
      assert.ok(!events.some((e) => e.type === "text"));
      const done: any = events.find((e) => e.type === "done");
      assert.equal(done.response.toolCalls[0].name, "read");
      assert.deepEqual(done.response.toolCalls[0].arguments, { path: "a.ts" });
      assert.equal(done.response.finishReason, "tool_calls");
    },
  );
});

test("Gemini stream falls back to a plain JSON body when SSE is absent", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        }),
      );
    },
    async (port) => {
      const adapter = new GeminiAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
        apiKey: "key",
      });
      const events = [];
      for await (const event of adapter.stream(request)) events.push(event);
      assert.deepEqual(events[0], { type: "text", text: "ok" });
      assert.equal(events[events.length - 1].type, "done");
    },
  );
});
