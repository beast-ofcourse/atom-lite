// task tool: the model-facing control surface over BackgroundTaskManager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashTool, taskTool } from "../../dist/tools/index.js";
import { BackgroundTaskManager } from "../../dist/runtime/background-tasks.js";
import type { ToolContext } from "../../dist/tools/types.js";

function ctx(mgr: BackgroundTaskManager | undefined): ToolContext {
  return {
    workspace: process.cwd(),
    signal: new AbortController().signal,
    backgroundTasks: mgr,
  };
}

test("background bash + task status/output flow", async () => {
  const mgr = new BackgroundTaskManager();
  const start = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: {
        command: `node -e "process.stdout.write('flow-out')"`,
        background: true,
      },
    },
    ctx(mgr),
  );
  assert.equal(start.isError, undefined);
  const parsed = JSON.parse(start.content);
  assert.equal(parsed.status, "started");
  assert.ok(parsed.task_id);

  const status = await taskTool.execute(
    {
      id: "2",
      name: "task",
      arguments: { action: "wait", id: parsed.task_id, timeoutMs: 10000 },
    },
    ctx(mgr),
  );
  const done = JSON.parse(status.content);
  assert.equal(done.status, "completed");
  assert.match(done.output, /flow-out/);
});

test("unknown task id reports TASK_NOT_FOUND", async () => {
  for (const action of ["status", "output", "wait", "cancel"] as const) {
    const r = await taskTool.execute(
      { id: "1", name: "task", arguments: { action, id: "missing" } },
      ctx(new BackgroundTaskManager()),
    );
    assert.equal(r.content, "TASK_NOT_FOUND");
    assert.equal(r.isError, true);
  }
});

test("no manager reports BACKGROUND_TASKS_UNAVAILABLE", async () => {
  for (const args of [
    { action: "status", id: "x" },
    { action: "cancel", id: "x" },
  ] as const) {
    const r = await taskTool.execute(
      { id: "1", name: "task", arguments: args },
      ctx(undefined),
    );
    assert.equal(r.content, "BACKGROUND_TASKS_UNAVAILABLE");
    assert.equal(r.isError, true);
  }
});

test("bash background:true without a manager fails explicitly", async () => {
  const r = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: { command: "echo hi", background: true },
    },
    ctx(undefined),
  );
  assert.equal(r.content, "BACKGROUND_TASKS_UNAVAILABLE");
  assert.equal(r.isError, true);
});

test("invalid action enum is rejected", async () => {
  const r = await taskTool.execute(
    { id: "1", name: "task", arguments: { action: "kill", id: "x" } },
    ctx(new BackgroundTaskManager()),
  );
  assert.match(r.content, /TOOL_ARGUMENT_INVALID/);
  assert.equal(r.isError, true);
});
