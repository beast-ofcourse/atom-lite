import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { OllamaAdapter } from "../../dist/providers/ollama.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";

async function withServer(handler: (req: any, res: any) => void, fn: (port: number) => Promise<void>) {
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

function rawValues(raw: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name.toLowerCase()) out.push(raw[i + 1]);
  }
  return out;
}

const userMessage = { role: "user", content: [{ type: "text", text: "hi" }] };

test("OpenAI-compatible: case-insensitive headers, auth precedence, request id", async () => {
  let raw: string[] = [];
  await withServer((req, res) => {
    raw = req.rawHeaders;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }, async (port) => {
    const adapter = new OpenAICompatibleAdapter({
      id: "t",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "key",
      headers: {
        "content-type": "application/problem+json",
        "authorization": "Bearer caller",
        "x-request-id": "caller-id",
      },
    });
    const r = await adapter.generate({
      model: "m",
      messages: [userMessage],
      requestId: "rid-123",
    });
    assert.equal(rawValues(raw, "content-type").length, 1);
    assert.equal(rawValues(raw, "content-type")[0], "application/problem+json");
    assert.deepEqual(rawValues(raw, "authorization"), ["Bearer key"]);
    assert.deepEqual(rawValues(raw, "x-request-id"), ["rid-123"]);
    assert.equal(r.requestId, "rid-123");
  });
});

test("Ollama: case-insensitive headers and request id", async () => {
  let raw: string[] = [];
  await withServer((req, res) => {
    raw = req.rawHeaders;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: "ok" }, done: true }));
  }, async (port) => {
    const adapter = new OllamaAdapter({
      id: "t",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": "caller-id",
      },
    });
    const r = await adapter.generate({
      model: "m",
      messages: [userMessage],
      requestId: "rid-ollama",
    });
    assert.equal(rawValues(raw, "content-type").length, 1);
    assert.equal(rawValues(raw, "content-type")[0], "application/problem+json");
    assert.deepEqual(rawValues(raw, "x-request-id"), ["rid-ollama"]);
    assert.equal(r.requestId, "rid-ollama");
  });
});

test("Gemini: case-insensitive headers and request id", async () => {
  let raw: string[] = [];
  await withServer((req, res) => {
    raw = req.rawHeaders;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
      }),
    );
  }, async (port) => {
    const adapter = new GeminiAdapter({
      id: "t",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "key",
      headers: { "content-type": "application/problem+json" },
    });
    const r = await adapter.generate({
      model: "m",
      messages: [userMessage],
      requestId: "rid-gemini",
    });
    assert.equal(rawValues(raw, "content-type").length, 1);
    assert.equal(rawValues(raw, "content-type")[0], "application/problem+json");
    assert.deepEqual(rawValues(raw, "x-request-id"), ["rid-gemini"]);
    assert.equal(r.requestId, "rid-gemini");
  });
});
