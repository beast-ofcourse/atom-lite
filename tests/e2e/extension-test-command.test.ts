// E2E: `atom-lite extension test <path>` exits by fixture result. No network:
// the harness dispatches before any provider is created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "atom-e2e-extension-test-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const fixtures = join(root, "fixtures");
for (const dir of [home, configHome, agentDir, fixtures])
  mkdirSync(dir, { recursive: true });
mkdirSync(join(configHome, "atom-lite"), { recursive: true });
writeFileSync(
  join(configHome, "atom-lite", "config.json"),
  JSON.stringify({ defaultProvider: "none", providers: {} }),
);

function cli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        PI_CODING_AGENT_DIR: agentDir,
      },
      encoding: "utf8",
      input: "",
      timeout: 30000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("extension test exits zero for a passing fixture", () => {
  const fixture = join(fixtures, "pass.js");
  writeFileSync(
    fixture,
    [
      "export default (pi) => { pi.metric('steps', 1); };",
      "export function test(ctx) {",
      "  ctx.assert.equal(ctx.doctor()[0].observability.metricCount, 1);",
      "}",
      "",
    ].join("\n"),
  );
  const result = cli(["extension", "test", fixture]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS|passed/);
});

test("extension test exits non-zero for a failing fixture", () => {
  const fixture = join(fixtures, "fail.js");
  writeFileSync(
    fixture,
    [
      "export default () => {};",
      "export function test(ctx) { ctx.assert.ok(false, 'intentional failure'); }",
      "",
    ].join("\n"),
  );
  const result = cli(["extension", "test", fixture]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /intentional failure/);
});

test("extension test exits non-zero when no fixture path is given", () => {
  const result = cli(["extension", "test"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extension test requires a fixture path/);
});
