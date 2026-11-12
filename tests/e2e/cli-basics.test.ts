// E2E: CLI surface behaviors that require the real binary (arg parsing,
// listing, exit codes). No network: the fake default provider answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../dist/version.js";

const root = mkdtempSync(join(tmpdir(), "atom-e2e-basics-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
for (const dir of [home, configHome, agentDir, project])
  mkdirSync(dir, { recursive: true });
// An explicit empty config avoids the first-run kilo default (network probe).
mkdirSync(join(configHome, "atom-lite"), { recursive: true });
writeFileSync(
  join(configHome, "atom-lite", "config.json"),
  JSON.stringify({ defaultProvider: "none", providers: {} }),
);

function cli(
  args: string[],
  opts: { input?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), ...args],
    {
      cwd: opts.cwd ?? project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        PI_CODING_AGENT_DIR: agentDir,
      },
      encoding: "utf8",
      input: opts.input ?? "",
      timeout: 30000,
    },
  );
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

test("--version prints the package version", () => {
  const { stdout } = cli(["--version"]);
  assert.equal(stdout.trim(), VERSION);
});

test("--help prints the usage line", () => {
  const { stdout } = cli(["--help"]);
  assert.match(stdout, /atom-lite \[task\]/);
  assert.match(stdout, /--no-tools/);
});

test("unknown --flags warn on stderr instead of vanishing", () => {
  const { stderr, stdout } = cli(["--json", "--obviously-typo", "hi"]);
  assert.match(stderr, /ignoring unknown option --obviously-typo/);
  assert.match(stdout, /"result"/);
});

test("--list-sessions on an empty store prints nothing fatal", () => {
  const { status } = cli(["--list-sessions"]);
  assert.equal(status, 0);
});

test("--search-sessions without a query exits non-zero", () => {
  const { status, stderr } = cli(["--search-sessions"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /--search-sessions requires a query/);
});

test("--json one-shot with no configured provider answers via the fake", () => {
  const { stdout, status } = cli(["--json", "hello"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  assert.match(parsed.result, /No provider configured; using fake/);
  assert.ok(parsed.sessionId);
});

test("stdin one-shot: piped task text is used as the prompt", () => {
  const { stdout } = cli(["--json"], { input: "piped task\n" });
  const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  assert.ok(parsed.sessionId);
});

test("--no-tools skips tool registration entirely", () => {
  const { stdout } = cli(["--json", "--no-tools", "hello"]);
  const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  assert.match(parsed.result, /No provider configured; using fake/);
});
