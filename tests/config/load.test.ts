import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../dist/config/load.js";

test("loadConfig returns defaults when no files exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.equal(cfg.defaultProvider, "kilo");
  assert.equal(cfg.runtime.mode, "yolo");
});

test("loadConfig reads project config", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ defaultProvider: "ollama-local" }),
  );
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.equal(cfg.defaultProvider, "ollama-local");
});

test("loadConfig reads runtime.agent from user config", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const userPath = join(dir, "user.json");
  writeFileSync(userPath, JSON.stringify({ runtime: { agent: "reviewer" } }));
  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.equal(cfg.runtime.agent, "reviewer");
});

test("runtime.agent is unset by default and user-owned", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(userPath, JSON.stringify({ runtime: { agent: "reviewer" } }));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ runtime: { agent: "planner" } }),
  );

  const configured = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.equal(configured.runtime.agent, "reviewer");

  const defaults = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "missing.json"),
  });
  assert.equal(defaults.runtime.agent, undefined);
});

test("loadConfig throws on invalid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ runtime: { maxParallelToolCalls: 0 } }),
  );
  assert.throws(() =>
    loadConfig({ projectRoot: dir, userConfigPath: join(dir, "nope.json") }),
  );
});

test("loadConfig defaults ui.theme to auto", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.equal(cfg.ui.theme, "auto");
  assert.equal(cfg.ui.mouse, true);
  assert.equal(cfg.ui.vimMode, false);
});

test("project config cannot enable or redirect the usage ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({
      usage: { ledgerEnabled: true, ledgerPath: "/tmp/user-ledger.jsonl" },
    }),
  );
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({
      usage: { ledgerEnabled: false, ledgerPath: "/tmp/project-ledger.jsonl" },
    }),
  );
  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.equal(cfg.usage.ledgerEnabled, true);
  assert.equal(cfg.usage.ledgerPath, "/tmp/user-ledger.jsonl");
});

test("project config cannot override user ui settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(userPath, JSON.stringify({ ui: { theme: "light" } }));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ ui: { theme: "dark", mouse: false } }),
  );
  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.equal(cfg.ui.theme, "light");
  assert.equal(cfg.ui.mouse, true);
});

// Reason: spec (lines 90, 123) — schema supplies all three repoMap defaults for old configs.
test("context.repoMap gets its defaults when the keys are absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.deepEqual((cfg.context as any).repoMap, {
    enabled: false,
    maxTokens: 1200,
    maxFiles: 400,
  });
});

// Reason: the repo map is opt-in; an explicit enable must survive config loading.
test("context.repoMap can be enabled explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ context: { repoMap: { enabled: true } } }),
  );
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.deepEqual((cfg.context as any).repoMap, {
    enabled: true,
    maxTokens: 1200,
    maxFiles: 400,
  });
});

// Reason: spec (lines 90, 123) — the new config keys parse with explicit values.
test("context.repoMap accepts explicit values", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({
      context: { repoMap: { enabled: false, maxTokens: 0, maxFiles: 12 } },
    }),
  );
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.deepEqual((cfg.context as any).repoMap, {
    enabled: false,
    maxTokens: 0,
    maxFiles: 12,
  });
});

// Reason: spec (line 90) — maxTokens is a non-negative integer.
test("context.repoMap rejects a negative maxTokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ context: { repoMap: { maxTokens: -1 } } }),
  );
  assert.throws(() =>
    loadConfig({ projectRoot: dir, userConfigPath: join(dir, "nope.json") }),
  );
});

// Reason: spec (lines 14, 90, 123) — upgrading does not break existing config files.
test("an old config without context.repoMap still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ context: { compactAtPercent: 70 } }),
  );
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.equal(cfg.context.compactAtPercent, 70);
  assert.equal((cfg.context as any).repoMap.enabled, false);
});

// Reason: spec (line 123) — project values win per key, so a partial project override keeps the user's other keys.
test("a partial project repoMap override keeps the user's other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({
      context: { repoMap: { enabled: false, maxTokens: 50, maxFiles: 7 } },
    }),
  );
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ context: { repoMap: { maxTokens: 99 } } }),
  );

  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.deepEqual((cfg.context as any).repoMap, {
    enabled: false,
    maxTokens: 99,
    maxFiles: 7,
  });
});
