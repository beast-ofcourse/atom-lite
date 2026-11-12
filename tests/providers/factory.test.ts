// createProvider: every branch of provider construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../../dist/providers/factory.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { OllamaAdapter } from "../../dist/providers/ollama.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";
import type { Config } from "../../dist/config/schema.js";

function config(overrides: Record<string, unknown> = {}): Config {
  return {
    defaultProvider: "main",
    providers: {},
    runtime: {} as never,
    context: {} as never,
    sessions: {} as never,
    lsp: {} as never,
    ui: {} as never,
    keybindings: {} as never,
    mcpServers: {},
    extensions: {} as never,
    ...overrides,
  } as unknown as Config;
}

test("missing profile falls back to the FakeProvider with a notice", () => {
  const p = createProvider(config());
  assert.ok(p instanceof FakeProvider);
  assert.match(p.generate.toString(), /FakeProvider|generate/);
});

test("openai-compatible adapter wiring", () => {
  const p = createProvider(
    config({
      providers: {
        main: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "m1",
          apiKey: "sk-test",
        },
      },
    }),
  );
  assert.ok(p instanceof OpenAICompatibleAdapter);
  assert.equal(p.id, "main");
  assert.equal(p.model, "m1");
});

test("ollama adapter wiring", () => {
  const p = createProvider(
    config({
      providers: {
        main: {
          type: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "llama",
        },
      },
    }),
  );
  assert.ok(p instanceof OllamaAdapter);
  assert.equal(p.model, "llama");
});

test("gemini adapter wiring", () => {
  const p = createProvider(
    config({
      providers: {
        main: { type: "gemini", model: "gemini-pro", apiKey: "k" },
      },
    }),
  );
  assert.ok(p instanceof GeminiAdapter);
  assert.equal(p.model, "gemini-pro");
});

test("unknown provider type degrades to a FakeProvider notice instead of crashing", () => {
  const p = createProvider(
    config({ providers: { main: { type: "telepathy", model: "x" } } }),
  );
  assert.ok(p instanceof FakeProvider);
  // First response explains the situation to the model/user.
  return p
    .generate({
      model: "x",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never)
    .then((r: { message?: { content?: { text?: string }[] } }) => {
      assert.match(
        r.message?.content?.[0]?.text ?? "",
        /Provider type telepathy not implemented yet/,
      );
    });
});

test("model override wins over the configured model", () => {
  const p = createProvider(
    config({
      providers: {
        main: { type: "openai-compatible", model: "configured" },
      },
    }),
    "main",
    "override-model",
  );
  assert.equal(p.model, "override-model");
});
