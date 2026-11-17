import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  parseGeminiUsage,
  parseOpenAIUsage,
} from "../../dist/providers/usage.js";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { recordModelUsage } from "../../dist/usage/ledger.js";

test("OpenAI-compatible usage parses cached-token details when reported", () => {
  const usage = parseOpenAIUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 60 },
  });
  assert.deepEqual(usage, {
    input: 100,
    output: 20,
    total: 120,
    cacheRead: 60,
  });
});

test("OpenAI-compatible usage parses Anthropic-style cache counters", () => {
  const usage = parseOpenAIUsage({
    prompt_tokens: 200,
    completion_tokens: 10,
    total_tokens: 210,
    cache_read_input_tokens: 150,
    cache_creation_input_tokens: 25,
  });
  assert.deepEqual(usage, {
    input: 200,
    output: 10,
    total: 210,
    cacheRead: 150,
    cacheWrite: 25,
  });
});

test("usage fixtures without cache fields leave the counters unset", () => {
  assert.deepEqual(
    parseOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    }),
    { input: 10, output: 2, total: 12 },
  );
  assert.deepEqual(
    parseGeminiUsage({
      promptTokenCount: 30,
      candidatesTokenCount: 4,
      totalTokenCount: 34,
    }),
    { input: 30, output: 4, total: 34 },
  );
});

test("Gemini usage reports cached content tokens", () => {
  assert.deepEqual(
    parseGeminiUsage({
      promptTokenCount: 300,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 3,
      totalTokenCount: 310,
      cachedContentTokenCount: 250,
    }),
    { input: 300, output: 10, total: 310, cacheRead: 250 },
  );
});

test("OpenAI-compatible adapter surfaces cache counters from a real response", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 4,
          total_tokens: 84,
          prompt_tokens_details: { cached_tokens: 70 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
    });
    const response = await adapter.generate({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(response.usage?.cacheRead, 70);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ledger records include cache counters only when reported", () => {
  const records: any[] = [];
  const ledger = { record: (r: any) => records.push(r) };
  const context = {
    sessionId: "s",
    requestId: "r",
    provider: "p",
    model: "m",
  };
  recordModelUsage(ledger, context, {
    input: 10,
    output: 2,
    total: 12,
    cacheRead: 8,
  });
  recordModelUsage(ledger, context, { input: 5, output: 1, total: 6 });

  assert.equal(records[0].usage.cacheRead, 8);
  assert.equal(records[0].usage.cacheWrite, undefined);
  assert.equal("cacheRead" in records[1].usage, false);
  assert.equal("cacheWrite" in records[1].usage, false);
});
