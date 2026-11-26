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

test("loadConfig survives an invalid runtime value and reports it", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ runtime: { maxParallelToolCalls: 0 } }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(cfg.runtime.maxParallelToolCalls, 10);
  assert.ok(warnings.some((w) => w.includes("maxParallelToolCalls")));
});

test("invalid JSON in user config starts with defaults and warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const userPath = join(dir, "user.json");
  writeFileSync(userPath, "{ not json");
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: userPath,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(cfg.defaultProvider, "kilo");
  assert.ok(warnings.some((w) => w.includes("invalid JSON")));
});

test("an invalid provider profile is ignored without blocking startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({
      defaultProvider: "main",
      providers: {
        main: { type: "openai-compatible", model: "m" },
        broken: { type: "openai-compatible" },
      },
    }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: userPath,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal((cfg.providers as any).main.model, "m");
  assert.equal((cfg.providers as any).broken, undefined);
  assert.ok(
    warnings.some(
      (w) => w.includes('provider "broken"') && w.includes("model"),
    ),
  );
});

test("loadConfig defaults ui.theme to nord", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.equal(cfg.ui.theme, "nord");
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
test("context.repoMap with a negative maxTokens falls back with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ context: { repoMap: { maxTokens: -1 } } }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual((cfg.context as any).repoMap, {
    enabled: false,
    maxTokens: 1200,
    maxFiles: 400,
  });
  assert.ok(warnings.some((w) => w.includes("maxTokens")));
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

// Reason: ticket 01 — web keys supply defaults when absent from both config files.
test("web config gets its defaults when the keys are absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
  });
  assert.deepEqual((cfg as any).web, {
    fetch: {
      cacheTtlSeconds: 300,
      maxBytes: 5242880,
      maxOutputChars: 30000,
      extract: "auto",
    },
    search: {
      provider: "auto",
      maxResults: 8,
      cacheTtlSeconds: 120,
      fallback: true,
    },
  });
});

// Reason: ticket 01 — a partial project override keeps user values for sibling leaves.
test("a partial project web override keeps sibling leaves", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({
      web: {
        fetch: { maxBytes: 1024, maxOutputChars: 5000 },
        search: { provider: "exa", maxResults: 5 },
      },
    }),
  );
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({
      web: { fetch: { maxBytes: 2048 }, search: { maxResults: 9 } },
    }),
  );

  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.deepEqual((cfg as any).web, {
    fetch: {
      cacheTtlSeconds: 300,
      maxBytes: 2048,
      maxOutputChars: 5000,
      extract: "auto",
    },
    search: {
      provider: "exa",
      maxResults: 9,
      cacheTtlSeconds: 120,
      fallback: true,
    },
  });
});

// Reason: ticket 01 — an unknown web key is reported, not fatal at startup.
test("web config with an unknown key falls back with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ web: { fetch: { bogus: 1 } } }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: join(dir, "nope.json"),
    onWarning: (message) => warnings.push(message),
  });
  assert.equal((cfg as any).web.fetch.cacheTtlSeconds, 300);
  assert.ok(warnings.some((w) => w.includes("bogus")));
});
