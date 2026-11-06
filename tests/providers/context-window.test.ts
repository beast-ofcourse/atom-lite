import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  contextWindowFromModelEntry,
  knownVisionModel,
  supportsVisionFromModelEntry,
  formatContextUsage,
  formatTokenCount,
  knownContextWindow,
} from "../../dist/providers/context-window.js";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";

async function withServer(
  handler: (req: any, res: any) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("formatTokenCount uses compact peer-style units", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1000), "1k");
  assert.equal(formatTokenCount(1234), "1.2k");
  assert.equal(formatTokenCount(9999), "10k");
  assert.equal(formatTokenCount(12_500), "13k");
  assert.equal(formatTokenCount(256_000), "256k");
  assert.equal(formatTokenCount(999_999), "1M");
  assert.equal(formatTokenCount(1_000_000), "1M");
  assert.equal(formatTokenCount(1_048_576), "1M");
  assert.equal(formatTokenCount(1_500_000), "1.5M");
});

test("formatContextUsage shows used over window and unknown values honestly", () => {
  assert.equal(formatContextUsage(1234, 1_000_000), "1.2k/1M");
  assert.equal(formatContextUsage(0, 256_000), "0/256k");
  assert.equal(formatContextUsage(undefined, 256_000), "?/256k");
  assert.equal(formatContextUsage(1234, undefined), "1.2k");
  assert.equal(formatContextUsage(undefined, undefined), "?");
});

test("knownContextWindow covers common hosted model families", () => {
  assert.equal(knownContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(knownContextWindow("openai/gpt-4.1"), 1_047_576);
  assert.equal(knownContextWindow("o4-mini"), 200_000);
  assert.equal(knownContextWindow("claude-sonnet-4-20250514"), 200_000);
  assert.equal(knownContextWindow("google/gemini-2.5-pro"), 1_048_576);
  assert.equal(knownContextWindow("gemini-1.5-pro"), 2_097_152);
  assert.equal(knownContextWindow("llama-3.3-70b-versatile"), 131_072);
  assert.equal(knownContextWindow("kilo-auto/free"), 256_000);
  assert.equal(knownContextWindow("some-unknown-model"), undefined);
});

test("contextWindowFromModelEntry reads common gateway metadata shapes", () => {
  assert.equal(contextWindowFromModelEntry({ context_length: 256_000 }), 256_000);
  assert.equal(
    contextWindowFromModelEntry({ top_provider: { context_length: 1_000_000 } }),
    1_000_000,
  );
  assert.equal(contextWindowFromModelEntry({ limits: { context: 128_000 } }), 128_000);
  assert.equal(contextWindowFromModelEntry({ context_window: 65_536 }), 65_536);
  assert.equal(contextWindowFromModelEntry({}), undefined);
  assert.equal(contextWindowFromModelEntry(null), undefined);
});

test("OpenAI-compatible adapter resolves the window from /models metadata", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "other-model", context_length: 131_072 },
            { id: "test-model", context_length: 256_000 },
          ],
        }),
      );
    },
    async (baseUrl) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "test",
        baseUrl,
        model: "test-model",
      });
      const info = await adapter.getModelInfo();
      assert.equal(info?.contextWindow, 256_000);
    },
  );
});

test("Gemini adapter resolves inputTokenLimit for the selected model", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { name: "models/gemini-2.5-flash", inputTokenLimit: 1_048_576 },
          ],
        }),
      );
    },
    async (baseUrl) => {
      const adapter = new GeminiAdapter({
        id: "google",
        baseUrl,
        model: "gemini-2.5-flash",
        apiKey: "test-key",
      });
      const info = await adapter.getModelInfo();
      assert.equal(info?.contextWindow, 1_048_576);
    },
  );
});


test("knownVisionModel recognizes common vision families", () => {
  assert.equal(knownVisionModel("gpt-4o"), true);
  assert.equal(knownVisionModel("claude-sonnet-4-20250514"), true);
  assert.equal(knownVisionModel("gemini-2.5-flash"), true);
  assert.equal(knownVisionModel("llava:13b"), true);
  assert.equal(knownVisionModel("qwen2.5-vl-7b"), true);
  assert.equal(knownVisionModel("some-unknown-model"), undefined);
});

test("supportsVisionFromModelEntry reads capability metadata", () => {
  assert.equal(supportsVisionFromModelEntry({ capabilities: ["vision", "text"] }), true);
  assert.equal(supportsVisionFromModelEntry({ modalities: ["text", "image"] }), true);
  assert.equal(supportsVisionFromModelEntry({ supports_vision: true }), true);
  assert.equal(supportsVisionFromModelEntry({}), undefined);
  assert.equal(supportsVisionFromModelEntry(null), undefined);
});

test("OpenAI-compatible adapter reports vision from metadata", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "test-model", context_length: 256_000, capabilities: ["vision"] }],
        }),
      );
    },
    async (baseUrl) => {
      const adapter = new OpenAICompatibleAdapter({ id: "test", baseUrl, model: "test-model" });
      const info = await adapter.getModelInfo();
      assert.equal(info?.supportsVision, true);
    },
  );
});

test("OpenAI-compatible adapter honors config override", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model", capabilities: ["vision"] }] }));
    },
    async (baseUrl) => {
      const adapter = new OpenAICompatibleAdapter({ id: "test", baseUrl, model: "test-model", supportsVision: false });
      const info = await adapter.getModelInfo();
      assert.equal(info?.supportsVision, false);
    },
  );
});

test("Gemini adapter reports vision support", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash", inputTokenLimit: 1_048_576 }] }));
    },
    async (baseUrl) => {
      const adapter = new GeminiAdapter({ id: "google", baseUrl, model: "gemini-2.5-flash", apiKey: "test-key" });
      const info = await adapter.getModelInfo();
      assert.equal(info?.supportsVision, true);
    },
  );
});
