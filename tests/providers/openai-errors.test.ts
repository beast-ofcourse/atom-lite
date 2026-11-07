import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";

async function withServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test("auth failure throws immediately without retry", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      await assert.rejects(
        () =>
          adapter.generate({
            model: "m",
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
            ],
          }),
        /PROVIDER_AUTH_FAILED/,
      );
      assert.equal(requests, 1);
    },
  );
});

test("retryable 500 then success", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const r = await adapter.generate({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      assert.equal(r.message.content[0].text, "ok");
      assert.equal(requests, 2);
    },
  );
});

test("requestId propagated to header and response", async () => {
  let seen;
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
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        requestId: "rid-123",
      });
      assert.equal(seen, "rid-123");
      assert.equal(r.requestId, "rid-123");
    },
  );
});

test("generated requestId differs across concurrent requests", async () => {
  const seen = new Set();
  await withServer(
    (req, res) => {
      seen.add(req.headers["x-request-id"]);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }, 50);
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "t",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
      });
      const [a, b] = await Promise.all([
        adapter.generate({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
        adapter.generate({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      ]);
      assert.notEqual(a.requestId, b.requestId);
      assert.equal(seen.size, 2);
    },
  );
});
