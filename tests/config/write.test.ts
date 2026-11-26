import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserConfig,
  saveMcpDisabled,
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

// Regression (ticket 09): an extension-bridged provider exists only in memory.
// A `/model` switch must not persist a provider profile containing just a model
// key, which would leave a broken profile behind after the extension is gone.
test("ephemeral provider selection does not write a partial provider to config.json", () => {
  const path = tempConfigPath();
  const original = JSON.stringify({
    defaultProvider: "openai",
    providers: {
      openai: { type: "openai-compatible", model: "gpt-4o-mini" },
    },
  });
  writeFileSync(path, original);
  saveProviderSelection(
    "extension-provider",
    { model: "extension-model" },
    { defaultProvider: "extension-provider", ephemeral: true, path },
  );
  assert.equal(readFileSync(path, "utf8"), original);
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

test("saveMcpDisabled persists one server without touching the others", () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        a: { command: "a", disabled: false, enabled: true },
        b: { command: "b" },
      },
      ui: { theme: "dark" },
    }),
  );
  saveMcpDisabled("a", true, path);
  const raw = readUserConfig(path) as any;
  assert.equal(raw.mcpServers.a.disable, true);
  assert.equal(raw.mcpServers.a.enabled, false);
  assert.equal("disabled" in raw.mcpServers.a, false);
  assert.equal(raw.mcpServers.a.command, "a");
  assert.equal(raw.mcpServers.b.command, "b");
  assert.equal(raw.ui.theme, "dark");
});
