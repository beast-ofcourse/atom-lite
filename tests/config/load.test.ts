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
