// Contract: the shipped Pi-style subagent extension discovers markdown agents,
// registers one tool, and runs a child turn through --mode json with an
// isolated system prompt and tool allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "atom-pi-subagent-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
for (const dir of [
  home,
  configHome,
  agentDir,
  join(agentDir, "agents"),
  project,
]) {
  mkdirSync(dir, { recursive: true });
}
mkdirSync(join(configHome, "atom-lite"), { recursive: true });
writeFileSync(
  join(configHome, "atom-lite", "config.json"),
  JSON.stringify({ defaultProvider: "none", providers: {} }),
);
writeFileSync(
  join(agentDir, "agents", "helper.md"),
  [
    "---",
    "name: helper",
    "description: Test helper",
    "tools: read",
    "---",
    "You are a helper. Return a short answer.",
  ].join("\n"),
);

const jiti = createJiti(import.meta.url);
const example = (await jiti.import(
  resolve("examples/extensions/subagent/index.ts"),
)) as {
  default: (pi: any) => void;
  test: (ctx: any) => Promise<void>;
};
const registered: any[] = [];
example.default({
  on: () => () => {},
  registerTool: (tool: any) => registered.push(tool),
});

test("shipped subagent example registers one tool", () => {
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "subagent");
});

test("child turn streams through --mode json without writing a session", async () => {
  const tool = registered[0];
  const previousArgv = process.argv[1];
  process.argv[1] = resolve("dist/cli/main.js");
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let result: any;
  try {
    result = await tool.execute(
      "call-1",
      { agent: "helper", task: " Say hello " },
      undefined,
      undefined,
      { workspace: project, hasUI: false, ui: {} },
    );
  } finally {
    process.argv[1] = previousArgv;
  }

  assert.match(result.content[0].text, /No provider configured; using fake/);
  assert.equal(result.details.results[0].status, "completed");
  assert.ok(result.details.results[0].usage.turns >= 1);
  const sessionDir = join(configHome, "atom-lite", "sessions");
  const logs = readdirSync(sessionDir).filter((name) =>
    name.endsWith(".jsonl"),
  );
  assert.deepEqual(logs, []);
});

test("--mode json emits parseable NDJSON records", () => {
  const run = spawnSync(
    process.execPath,
    [
      resolve("dist/cli/main.js"),
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--tools",
      "read",
      "--thinking",
      "low",
      "--append-system-prompt",
      join(agentDir, "agents", "helper.md"),
      "hello",
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        PI_CODING_AGENT_DIR: agentDir,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const records = run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.type === "message_end"));
  assert.equal(records.at(-1).type, "result");
  assert.match(records.at(-1).result, /No provider configured; using fake/);
});
