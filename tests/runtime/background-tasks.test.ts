// BackgroundTaskManager: the full bash background:true -> task pipeline.
// Integration-level: real child processes, short commands, bounded waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskManager } from "../../dist/runtime/background-tasks.js";

const SHELL_ECHO = `node -e "process.stdout.write('bg-out');process.stderr.write('bg-err')"`;

test("start -> wait -> completed with collected output", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(SHELL_ECHO, process.cwd(), process.env);
  assert.equal(t.status, "running");
  const done = await mgr.wait(t.id, 10000);
  assert.ok(done);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /bg-out/);
  assert.match(done.output, /bg-err/);
});

test("get and output return the live record", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(
    `node -e "setTimeout(()=>{},50)"`,
    process.cwd(),
    process.env,
  );
  const live = mgr.get(t.id);
  assert.ok(live);
  assert.equal(live.status, "running");
  await mgr.wait(t.id, 10000);
  assert.equal(mgr.get(t.id)?.status, "completed");
});

test("unknown id returns undefined", async () => {
  const mgr = new BackgroundTaskManager();
  assert.equal(mgr.get("nope"), undefined);
  assert.equal(await mgr.wait("nope", 10), undefined);
});

test("concurrency cap rejects beyond 4 running tasks", async () => {
  const mgr = new BackgroundTaskManager();
  const sleep = `node -e "setTimeout(()=>{},200)"`;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push(mgr.start(sleep, process.cwd(), process.env).id);
  }
  assert.throws(() => mgr.start(sleep, process.cwd(), process.env), {
    message: /too many background tasks/,
  });
  for (const id of ids) mgr.cancel(id);
  // After cancellation the slots free up.
  await new Promise((r) => setTimeout(r, 50));
  const t = mgr.start(`echo ok`, process.cwd(), process.env);
  await mgr.wait(t.id, 10000);
  assert.equal(mgr.get(t.id)?.status, "completed");
});

test("cancel terminates a running task", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(
    `node -e "setInterval(()=>{},50)"`,
    process.cwd(),
    process.env,
  );
  await new Promise((r) => setTimeout(r, 50));
  const after = mgr.cancel(t.id);
  assert.ok(after);
  // Status flips once the process actually exits.
  const done = await mgr.wait(t.id, 10000);
  assert.ok(["cancelled", "failed"].includes(done?.status ?? ""));
});

test("wait resolves with the finished record when already done", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(`echo fast`, process.cwd(), process.env);
  await mgr.wait(t.id, 10000);
  const again = await mgr.wait(t.id, 10000);
  assert.equal(again?.status, "completed");
});

test("drainCompleted yields finished tasks and empties the queue", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(`echo drained`, process.cwd(), process.env);
  await mgr.wait(t.id, 10000);
  const drained = mgr.drainCompleted();
  assert.ok(drained.some((x) => x.id === t.id));
  assert.equal(mgr.drainCompleted().length, 0);
});

test("cancel settles to cancelled immediately and frees the slot", async () => {
  const mgr = new BackgroundTaskManager();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    ids.push(
      mgr.start(`node -e "setInterval(()=>{},50)"`, process.cwd(), process.env).id,
    );
  }
  const cancelled = mgr.cancel(ids[0]);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.signal, "SIGTERM");
  assert.ok(cancelled?.finishedAt);
  const immediate = await mgr.wait(ids[0], 1);
  assert.equal(immediate?.status, "cancelled");
  const replacement = mgr.start(`echo freed`, process.cwd(), process.env);
  assert.ok(replacement.id);
  for (const id of ids.slice(1)) mgr.cancel(id);
  mgr.cancel(replacement.id);
});

test("waitDetailed reports timedOut separately from completion", async () => {
  const mgr = new BackgroundTaskManager();
  const slow = mgr.start(`node -e "setTimeout(()=>{},300)"`, process.cwd(), process.env);
  const timed = await mgr.waitDetailed(slow.id, 20);
  assert.equal(timed?.timedOut, true);
  assert.equal(timed?.task?.status, "running");
  const done = await mgr.waitDetailed(slow.id, 5000);
  assert.equal(done?.timedOut, false);
  assert.equal(done?.task?.status, "completed");
});

test("onComplete fires once with the settled record for auto-notification", async () => {
  const mgr = new BackgroundTaskManager();
  const seen: string[] = [];
  mgr.setOnComplete((t) => seen.push(`${t.id}:${t.status}`));
  const done = mgr.start(`echo notified`, process.cwd(), process.env);
  await mgr.wait(done.id, 10000);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [`${done.id}:completed`]);

  const cancelled = mgr.start(`node -e "setInterval(()=>{},50)"`, process.cwd(), process.env);
  mgr.cancel(cancelled.id);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen.includes(`${cancelled.id}:cancelled`));
  assert.equal(seen.filter((s) => s.startsWith(cancelled.id)).length, 1);
});

test("list enumerates live task records", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(`echo listed`, process.cwd(), process.env);
  const all = mgr.list();
  assert.ok(all.some((x) => x.id === t.id));
  assert.equal(all.find((x) => x.id === t.id)?.type, "shell");
  await mgr.wait(t.id, 10000);
});

test("failed task carries an error field", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(`node -e "process.exit(3)"`, process.cwd(), process.env);
  const done = await mgr.wait(t.id, 10000);
  assert.equal(done?.status, "failed");
  assert.equal(done?.exitCode, 3);
  assert.equal(done?.error, "COMMAND_FAILED");
  assert.ok(done?.durationMs !== undefined);
});

test("finished records are pruned so the manager cannot grow unbounded", async () => {
  const mgr = new BackgroundTaskManager();
  const ids: string[] = [];
  // 40 sequential finished tasks; retention keeps the most recent 32.
  for (let i = 0; i < 40; i++) {
    const t = mgr.start(`echo task-${i}`, process.cwd(), process.env);
    ids.push(t.id);
    await mgr.wait(t.id, 10000);
  }
  assert.equal(mgr.get(ids[0]), undefined, "oldest record pruned");
  assert.equal(mgr.get(ids[5]), undefined, "old records pruned");
  assert.ok(mgr.get(ids[39]), "newest record retained");
});
