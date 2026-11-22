// task tool: the model-facing control surface over BackgroundTaskManager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashTool, taskTool } from "../../dist/tools/index.js";
import { BackgroundTaskManager } from "../../dist/runtime/background-tasks.js";
import { readFileSync } from "node:fs";
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

test("task start launches registered subagent and image producers", async () => {
  const mgr = new BackgroundTaskManager();
  mgr.registerProducer("subagent", async (params) => `answer:${String(params.prompt)}`);
  mgr.registerProducer("image", async () => "/tmp/generated.svg");

  const sub = await taskTool.execute(
    {
      id: "1",
      name: "task",
      arguments: {
        action: "start",
        kind: "subagent",
        params: { prompt: "hi" },
        agent: "scout",
        description: "delegated",
      },
    },
    ctx(mgr),
  );
  const subStarted = JSON.parse(sub.content);
  assert.equal(subStarted.status, "running");
  assert.equal(mgr.get(subStarted.task_id)?.type, "subagent");
  assert.equal(mgr.get(subStarted.task_id)?.agent, "scout");
  assert.equal((await mgr.wait(subStarted.task_id, 5000))?.output, "answer:hi");

  const image = await taskTool.execute(
    {
      id: "2",
      name: "task",
      arguments: {
        action: "start",
        kind: "image",
        params: { command: "true" },
        path: "/tmp/generated.svg",
      },
    },
    ctx(mgr),
  );
  const imageStarted = JSON.parse(image.content);
  assert.equal(mgr.get(imageStarted.task_id)?.type, "image");
  assert.equal(
    (await mgr.wait(imageStarted.task_id, 5000))?.output,
    "/tmp/generated.svg",
  );
});

test("task start without a registered producer fails explicitly", async () => {
  const result = await taskTool.execute(
    { id: "1", name: "task", arguments: { action: "start", kind: "image" } },
    ctx(new BackgroundTaskManager()),
  );
  assert.equal(result.content, "NO_PRODUCER_FOR_image");
  assert.equal(result.isError, true);
});

test("foreground timeout moves the command to the background", async () => {
  const mgr = new BackgroundTaskManager();
  const start = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: {
        command: `node -e "setTimeout(()=>console.log('late'),150)"`,
        timeout_ms: 60,
      },
    },
    { ...ctx(mgr), maxBashTimeMs: 5000 },
  );
  const result = JSON.parse(start.content);
  assert.equal(result.status, "running");
  assert.equal(result.timed_out, true);
  assert.ok(result.task_id);
  assert.ok(result.outputPath);
  const done = await mgr.wait(result.task_id, 5000);
  assert.equal(done?.status, "completed");
  assert.match(done?.output ?? "", /late/);
});

test("truncated foreground output is saved to a file", async () => {
  const result = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: { command: `node -e "process.stdout.write('z'.repeat(4000))"` },
    },
    { ...ctx(undefined), maxToolOutputBytes: 100 },
  );
  assert.match(result.content, /OUTPUT_TRUNCATED/);
  const path = result.content.match(/outputPath: (\S+)/)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path!, "utf8").length, 4000);
});

test("list action returns live task records", async () => {
  const mgr = new BackgroundTaskManager();
  const start = JSON.parse(
    (
      await bashTool.execute(
        {
          id: "1",
          name: "bash",
          arguments: { command: `node -e "setTimeout(()=>{},200)"`, background: true },
        },
        ctx(mgr),
      )
    ).content,
  );
  const listed = await taskTool.execute(
    { id: "2", name: "task", arguments: { action: "list" } },
    ctx(mgr),
  );
  const tasks = JSON.parse(listed.content);
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.some((t: { id: string }) => t.id === start.task_id));
  mgr.cancel(start.task_id);
});

test("wait action exposes timed_out on deadline", async () => {
  const mgr = new BackgroundTaskManager();
  const start = JSON.parse(
    (
      await bashTool.execute(
        {
          id: "1",
          name: "bash",
          arguments: { command: `node -e "setTimeout(()=>{},300)"`, background: true },
        },
        ctx(mgr),
      )
    ).content,
  );
  const waited = await taskTool.execute(
    {
      id: "2",
      name: "task",
      arguments: { action: "wait", id: start.task_id, timeoutMs: 20 },
    },
    ctx(mgr),
  );
  const result = JSON.parse(waited.content);
  assert.equal(result.timed_out, true);
  assert.equal(result.status, "running");
  mgr.cancel(start.task_id);
});

test("cancel action reports cancelled immediately", async () => {
  const mgr = new BackgroundTaskManager();
  const start = JSON.parse(
    (
      await bashTool.execute(
        {
          id: "1",
          name: "bash",
          arguments: { command: `node -e "setInterval(()=>{},50)"`, background: true },
        },
        ctx(mgr),
      )
    ).content,
  );
  const cancelled = await taskTool.execute(
    { id: "2", name: "task", arguments: { action: "cancel", id: start.task_id } },
    ctx(mgr),
  );
  assert.equal(JSON.parse(cancelled.content).status, "cancelled");
});

test("invalid action enum is rejected", async () => {
  const r = await taskTool.execute(
    { id: "1", name: "task", arguments: { action: "kill", id: "x" } },
    ctx(new BackgroundTaskManager()),
  );
  assert.match(r.content, /TOOL_ARGUMENT_INVALID/);
  assert.equal(r.isError, true);
});
