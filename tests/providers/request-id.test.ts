import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { OllamaAdapter } from "../../dist/providers/ollama.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";

async function withServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>,
) {
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

const userMessage = { role: "user", content: [{ type: "text", text: "hi" }] };

test("explicit requestId is sent and returned for generate", async () => {
  let seen: string | undefined;
  await withServer(
    (req, res) => {
      seen = req.headers["x-request-id"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const r = await adapter.generate({
        model: "m",
        messages: [userMessage],
        requestId: "rid-explicit",
      });
      assert.equal(seen, "rid-explicit");
      assert.equal(r.requestId, "rid-explicit");
    },
  );
});

test("generated requestId is non-empty and returned", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const r = await adapter.generate({ model: "m", messages: [userMessage] });
      assert.ok(typeof r.requestId === "string" && r.requestId.length > 0);
    },
  );
});

test("Ollama stream propagates the request id", async () => {
  let seen: string | undefined;
  await withServer(
    (req, res) => {
      seen = req.headers["x-request-id"];
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        JSON.stringify({ message: { content: "ok" }, done: true }) + "\n",
      );
    },
    async (port) => {
      const adapter = new OllamaAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      let doneResponse: any;
      for await (const event of adapter.stream({
        model: "m",
        messages: [userMessage],
        requestId: "rid-ollama-stream",
      })) {
        if (event.type === "done") doneResponse = event.response;
      }
      assert.equal(seen, "rid-ollama-stream");
      assert.equal(doneResponse.requestId, "rid-ollama-stream");
    },
  );
});

test("Gemini stream propagates the request id", async () => {
  let seen: string | undefined;
  await withServer(
    (req, res) => {
      seen = req.headers["x-request-id"];
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
      let doneResponse: any;
      for await (const event of adapter.stream({
        model: "m",
        messages: [userMessage],
        requestId: "rid-gemini-stream",
      })) {
        if (event.type === "done") doneResponse = event.response;
      }
      assert.equal(seen, "rid-gemini-stream");
      assert.equal(doneResponse.requestId, "rid-gemini-stream");
    },
  );
});

test("repeated generate requests get distinct request ids", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const a = await adapter.generate({ model: "m", messages: [userMessage] });
      const b = await adapter.generate({ model: "m", messages: [userMessage] });
      assert.notEqual(a.requestId, b.requestId);
    },
  );
});

test("concurrent generate requests get distinct request ids", async () => {
  await withServer(
    (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }, 20);
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const [a, b] = await Promise.all([
        adapter.generate({ model: "m", messages: [userMessage] }),
        adapter.generate({ model: "m", messages: [userMessage] }),
      ]);
      assert.notEqual(a.requestId, b.requestId);
    },
  );
});

test("retry reuses the same request id", async () => {
  const seen: string[] = [];
  await withServer(
    (req, res) => {
      seen.push(req.headers["x-request-id"]);
      if (seen.length === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const r = await adapter.generate({
        model: "m",
        messages: [userMessage],
        requestId: "rid-retry",
      });
      assert.equal(seen.length, 2);
      assert.deepEqual(seen, ["rid-retry", "rid-retry"]);
      assert.equal(r.requestId, "rid-retry");
    },
  );
});

test("stream sends and returns an explicit request id", async () => {
  let seen: string | undefined;
  await withServer(
    (req, res) => {
      seen = req.headers["x-request-id"];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      let doneResponse: any;
      for await (const ev of adapter.stream({
        model: "m",
        messages: [userMessage],
        requestId: "rid-stream",
      })) {
        if (ev.type === "done") doneResponse = ev.response;
      }
      assert.equal(seen, "rid-stream");
      assert.equal(doneResponse.requestId, "rid-stream");
    },
  );
});
