// Config schema: defaults, validation, and the fields that must reach the
// runtime. Regression guard: runtime limits and sessions retention were once
// parsed but silently ignored by the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../dist/config/load.js";
import { ConfigSchema } from "../../dist/config/schema.js";
import { DEFAULT_CONFIG } from "../../dist/config/defaults.js";

function configHome(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const atom = join(dir, "atom-lite");
  mkdirSync(atom, { recursive: true });
  return { dir, path: join(atom, "config.json") };
}

test("empty config yields documented defaults", () => {
  const cfg = ConfigSchema.parse({});
  assert.equal(cfg.defaultProvider, "openai-compatible");
  assert.equal(cfg.runtime.maxParallelToolCalls, 10);
  assert.equal(cfg.runtime.maxToolOutputBytes, 30000);
  assert.equal(cfg.runtime.maxBashTimeMs, 120000);
  assert.equal(cfg.runtime.mode, "yolo");
  assert.equal(cfg.context.reserveOutputTokens, 4096);
  assert.equal(cfg.context.compactAtPercent, 85);
  assert.equal(cfg.sessions.enabled, true);
  assert.equal(cfg.sessions.retentionDays, null);
  assert.equal(cfg.ui.theme, "auto");
  assert.equal(cfg.runtime.checkpointing, undefined);
});

test("old configs carrying runtime.checkpointing still parse (ignored)", () => {
  // The runtime object is .strict(): the deprecated key must stay accepted
  // or every config written before checkpoint removal would fail to load.
  const cfg = ConfigSchema.parse({ runtime: { checkpointing: true } });
  assert.equal(cfg.runtime.checkpointing, true);
  const off = ConfigSchema.parse({ runtime: { checkpointing: false } });
  assert.equal(off.runtime.checkpointing, false);
});

test("loadConfig reads a valid user config file", () => {
  const { dir, path } = configHome();
  writeFileSync(
    path,
    JSON.stringify({
      defaultProvider: "main",
      providers: { main: { type: "openai-compatible", model: "m" } },
    }),
  );
  const cfg = loadConfig({
    userConfigPath: path,
    projectRoot: join(dir, "proj"),
  });
  assert.equal(cfg.defaultProvider, "main");
  assert.equal((cfg.providers as any).main.model, "m");
  rmSync(dir, { recursive: true, force: true });
});

test("unknown top-level keys are rejected, not silently ignored", () => {
  const { dir, path } = configHome();
  writeFileSync(
    path,
    JSON.stringify({ totallyUnknownField: true, providers: {} }),
  );
  assert.throws(() =>
    loadConfig({ userConfigPath: path, projectRoot: join(dir, "proj") }),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("runtime limits triad is present after load so it can reach AgentRuntime", () => {
  // Regression: app.ts once constructed AgentRuntime without limits, making
  // these three fields dead.
  const { dir, path } = configHome();
  writeFileSync(
    path,
    JSON.stringify({
      runtime: {
        maxParallelToolCalls: 3,
        maxToolOutputBytes: 12345,
        maxBashTimeMs: 4567,
      },
    }),
  );
  const cfg = loadConfig({
    userConfigPath: path,
    projectRoot: join(dir, "proj"),
  });
  assert.equal(cfg.runtime.maxParallelToolCalls, 3);
  assert.equal(cfg.runtime.maxToolOutputBytes, 12345);
  assert.equal(cfg.runtime.maxBashTimeMs, 4567);
  rmSync(dir, { recursive: true, force: true });
});

test("sessions.enabled=false and retentionDays are preserved by load", () => {
  const { dir, path } = configHome();
  writeFileSync(
    path,
    JSON.stringify({ sessions: { enabled: false, retentionDays: 14 } }),
  );
  const cfg = loadConfig({
    userConfigPath: path,
    projectRoot: join(dir, "proj"),
  });
  assert.equal(cfg.sessions.enabled, false);
  assert.equal(cfg.sessions.retentionDays, 14);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid values fail loudly", () => {
  assert.throws(() =>
    ConfigSchema.parse({ runtime: { maxParallelToolCalls: 0 } }),
  );
  assert.throws(() =>
    ConfigSchema.parse({ context: { compactAtPercent: 200 } }),
  );
  assert.throws(() => ConfigSchema.parse({ sessions: { retentionDays: -1 } }));
});

test("DEFAULT_CONFIG agrees with schema defaults", () => {
  const schemaDefaults = ConfigSchema.parse({});
  assert.equal(DEFAULT_CONFIG.runtime.mode, schemaDefaults.runtime.mode);
  assert.equal(
    DEFAULT_CONFIG.runtime.maxToolOutputBytes,
    schemaDefaults.runtime.maxToolOutputBytes,
  );
  assert.equal(
    DEFAULT_CONFIG.runtime.maxBashTimeMs,
    schemaDefaults.runtime.maxBashTimeMs,
  );
  assert.equal(
    DEFAULT_CONFIG.sessions.enabled,
    schemaDefaults.sessions.enabled,
  );
});
