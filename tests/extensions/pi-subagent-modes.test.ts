// Flow: the shipped subagent extension runs parallel and chain modes, rejects
// a cwd escape, and an already-aborted turn spawns nothing. A fixture child
// makes the chain's {previous} substitution observable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "atom-pi-subagent-modes-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
const fixtureScript = join(root, "child.js");
const marker = join(root, "spawned.marker");
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
  "---\nname: helper\ndescription: Test helper\n---\nYou are a helper.\n",
);
writeFileSync(
  fixtureScript,
  [
    "const args = process.argv.slice(2);",
    'const raw = args.find((a) => a.startsWith("Task: ")) ?? "Task: ";',
    "const task = raw.slice(6);",
    "if (process.env.SUBAGENT_MARKER)",
    '  require("node:fs").writeFileSync(process.env.SUBAGENT_MARKER, "spawned");',
    'const message = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `OUT:${task}` }] } };',
    'process.stdout.write(JSON.stringify(message) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "result", result: `OUT:${task}`, sessionId: "fixture" }) + "\\n");',
  ].join("\n"),
);

const jiti = createJiti(import.meta.url);
const example = (await jiti.import(
  resolve("examples/extensions/subagent/index.ts"),
)) as { default: (pi: any) => void };
const tools: any[] = [];
example.default({
  on: () => () => {},
  registerTool: (tool: any) => tools.push(tool),
});
const tool = tools[0];

const previousArgv = process.argv[1];
const ctx = { workspace: project, hasUI: false, ui: {} };

function isolate(script: string) {
  process.argv[1] = script;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return () => {
    process.argv[1] = previousArgv;
  };
}

test("parallel mode returns one result per task", async () => {
  const restore = isolate(resolve("dist/cli/main.js"));
  try {
    const result = await tool.execute(
      "parallel-1",
      {
        tasks: [
          { agent: "helper", task: "first" },
          { agent: "helper", task: "second" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.details.mode, "parallel");
    assert.equal(result.details.results.length, 2);
    assert.ok(
      result.details.results.every((r: any) => r.status === "completed"),
    );
    assert.match(result.content[0].text, /Parallel: 2\/2 succeeded/);
  } finally {
    restore();
  }
});

test("chain mode substitutes {previous} and stops on failure", async () => {
  const fixture = isolate(fixtureScript);
  try {
    const result = await tool.execute(
      "chain-1",
      {
        chain: [
          { agent: "helper", task: "first" },
          { agent: "helper", task: "continue {previous}" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.details.mode, "chain");
    assert.deepEqual(
      result.details.results.map((r: any) => r.step),
      [1, 2],
    );
    assert.equal(result.details.results[0].task, "first");
    assert.equal(result.details.results[1].task, "continue OUT:first");
  } finally {
    fixture();
  }

  const restore = isolate(resolve("dist/cli/main.js"));
  try {
    const failed = await tool.execute(
      "chain-2",
      {
        chain: [
          { agent: "missing", task: "first" },
          { agent: "helper", task: "never runs" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(failed.details.results.length, 1);
    assert.equal(failed.details.results[0].status, "failed");
    assert.match(failed.content[0].text, /Chain stopped at step 1/);
  } finally {
    restore();
  }
});

test("a model-supplied cwd outside the workspace is rejected", async () => {
  const result = await tool.execute(
    "cwd-1",
    { agent: "helper", task: "hello", cwd: "../../" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.results[0].status, "failed");
  assert.match(result.details.results[0].errorMessage, /cwd escapes/);
});

test("an aborted turn does not spawn a child", async () => {
  process.env.SUBAGENT_MARKER = marker;
  const restore = isolate(fixtureScript);
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await tool.execute(
      "abort-1",
      { agent: "helper", task: "hello" },
      controller.signal,
      undefined,
      ctx,
    );
    assert.equal(result.details.results[0].status, "aborted");
    assert.equal(existsSync(marker), false);
  } finally {
    restore();
    delete process.env.SUBAGENT_MARKER;
  }
});
