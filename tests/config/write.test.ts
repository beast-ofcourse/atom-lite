import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserConfig,
  saveProviderModel,
  saveProviderSelection,
  saveTheme,
  updateUserConfig,
} from "../../dist/config/write.js";

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "atom-config-"));
  return join(dir, "config.json");
}

test("saveProviderSelection preserves unrelated user config", () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    JSON.stringify({
      runtime: { mode: "yolo" },
      providers: {
        kilo: { type: "openai-compatible", model: "kilo-auto/free" },
      },
    }),
  );
  saveProviderSelection(
    "openai",
    {
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    },
    { defaultProvider: "openai", path },
  );
  const raw = readUserConfig(path) as any;
  assert.equal(raw.defaultProvider, "openai");
  assert.equal(raw.runtime.mode, "yolo");
  assert.equal(raw.providers.kilo.model, "kilo-auto/free");
  assert.equal(raw.providers.openai.baseUrl, "https://api.openai.com/v1");
});

test("saveProviderSelection merges into an existing profile", () => {
  const path = tempConfigPath();
  saveProviderSelection(
    "openai",
    { type: "openai-compatible", model: "gpt-4o-mini" },
    { path },
  );
  saveProviderSelection("openai", { model: "gpt-4.1" }, { path });
  const raw = readUserConfig(path) as any;
  assert.equal(raw.providers.openai.type, "openai-compatible");
  assert.equal(raw.providers.openai.model, "gpt-4.1");
});

test("saveProviderModel only changes the model", () => {
  const path = tempConfigPath();
  saveProviderSelection(
    "anthropic",
    { type: "openai-compatible", model: "claude-sonnet-4-20250514" },
    { path },
  );
  saveProviderModel("anthropic", "claude-3-5-haiku-latest", path);
  const raw = readUserConfig(path) as any;
  assert.equal(raw.providers.anthropic.model, "claude-3-5-haiku-latest");
  assert.equal(raw.providers.anthropic.type, "openai-compatible");
});

test("updateUserConfig writes valid JSON with a trailing newline", () => {
  const path = tempConfigPath();
  updateUserConfig((cfg) => {
    cfg.defaultProvider = "kilo";
  }, path);
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.equal(JSON.parse(text).defaultProvider, "kilo");
});

test("saveTheme only changes ui.theme", () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    JSON.stringify({
      ui: { mouse: false },
      runtime: { mode: "yolo" },
    }),
  );
  saveTheme("light", path);
  const raw = readUserConfig(path) as any;
  assert.equal(raw.ui.theme, "light");
  assert.equal(raw.ui.mouse, false);
  assert.equal(raw.runtime.mode, "yolo");
});
