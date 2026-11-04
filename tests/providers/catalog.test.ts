import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableProviderNames,
  getPreset,
  isLikelyChatModel,
  materializeProviderConfig,
  probeApiKey,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../../dist/providers/catalog.js";
import { saveApiKey } from "../../dist/config/credentials.js";
import { filterPickerItems } from "../../dist/cli/picker.js";

test("catalog includes hosted and local provider presets", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  for (const id of ["kilo", "openai", "anthropic", "google", "openrouter", "ollama"]) {
    assert.ok(ids.includes(id), `missing preset ${id}`);
  }
  assert.equal(getPreset("anthropic")?.type, "openai-compatible");
  assert.equal(getPreset("google")?.type, "gemini");
  assert.equal(getPreset("ollama")?.requiresKey, false);
});

test("materializeProviderConfig keeps an existing model choice", () => {
  const preset = getPreset("openai")!;
  const cfg = materializeProviderConfig(preset, { model: "gpt-4.1" });
  assert.equal(cfg.model, "gpt-4.1");
  assert.equal(cfg.type, "openai-compatible");
  assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.apiKeyEnv, "OPENAI_API_KEY");
});

test("availableProviderNames includes configured and credential-backed profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-catalog-"));
  const credsPath = join(dir, "credentials.json");
  saveApiKey("anthropic", "sk-ant", credsPath);
  const config = {
    defaultProvider: "kilo",
    providers: {
      kilo: { type: "openai-compatible", model: "kilo-auto/free" },
    },
  } as any;
  const names = availableProviderNames(config, credsPath);
  assert.ok(names.includes("kilo"));
  assert.ok(names.includes("anthropic"));
});

test("isLikelyChatModel rejects embeddings and audio models", () => {
  assert.equal(isLikelyChatModel("gpt-4o-mini"), true);
  assert.equal(isLikelyChatModel("text-embedding-3-small"), false);
  assert.equal(isLikelyChatModel("gpt-4o-audio-preview"), false);
});

test("filterPickerItems matches via fuzzy search across provider and model", () => {
  const items = [
    { value: "openai\u0000gpt-4o-mini", label: "gpt-4o-mini", description: "OpenAI" },
    { value: "anthropic\u0000claude-sonnet-4", label: "claude-sonnet-4", description: "Anthropic" },
    { value: "google\u0000gemini-2.5-flash", label: "gemini-2.5-flash", description: "Google Gemini" },
  ];
  assert.deepEqual(
    filterPickerItems(items, "claude").map((i) => i.label),
    ["claude-sonnet-4"],
  );
  assert.deepEqual(
    filterPickerItems(items, "gem flash").map((i) => i.label),
    ["gemini-2.5-flash"],
  );
  assert.deepEqual(filterPickerItems(items, "").length, 3);
});

async function withServer(
  handler: (req: any, res: any) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const localPreset = (baseUrl: string): ProviderPreset => ({
  id: "local",
  label: "Local",
  description: "test",
  type: "openai-compatible",
  baseUrl,
  model: "test-model",
  requiresKey: true,
  keyEnv: "LOCAL_KEY",
  fallbackModels: ["test-model"],
});

test("probeApiKey accepts a valid key and returns chat models", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, "Bearer good-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model" }, { id: "text-embedding-3-small" }] }));
    },
    async (baseUrl) => {
      const result = await probeApiKey(localPreset(baseUrl), "good-key", 2000);
      assert.equal(result.ok, true);
      assert.deepEqual(result.models, ["test-model"]);
      assert.equal(result.invalid, false);
    },
  );
});

test("probeApiKey flags an auth rejection", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
    },
    async (baseUrl) => {
      const result = await probeApiKey(localPreset(baseUrl), "bad-key", 2000);
      assert.equal(result.ok, false);
      assert.equal(result.invalid, true);
    },
  );
});
