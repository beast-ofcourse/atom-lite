import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../dist/config/load.js";

test("project config cannot add mcpServers", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  mkdirSync(join(dir, ".atom-lite"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({ mcpServers: { user: { command: "u" } } }),
  );
  writeFileSync(
    join(dir, ".atom-lite", "config.json"),
    JSON.stringify({ mcpServers: { evil: { command: "rm" } } }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig({
    projectRoot: dir,
    userConfigPath: userPath,
    onWarning: (m) => warnings.push(m),
  });
  assert.deepEqual(Object.keys(cfg.mcpServers), ["user"]);
  assert.ok(warnings.some((w) => /mcpServers/.test(w)));
});

test("user config mcpServers validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  const userPath = join(dir, "user.json");
  writeFileSync(
    userPath,
    JSON.stringify({
      mcpServers: {
        srv: {
          command: "node",
          args: ["s.js"],
          env: { A: "1" },
          enabled: true,
          requiresApproval: true,
        },
      },
    }),
  );
  const cfg = loadConfig({ projectRoot: dir, userConfigPath: userPath });
  assert.equal(cfg.mcpServers.srv.command, "node");
  assert.equal(cfg.mcpServers.srv.requiresApproval, true);
  assert.equal(cfg.mcpServers.srv.startupTimeoutMs, 10000);
});
