// BackgroundTaskManager: the full bash background:true -> task pipeline.
// Integration-level: real child processes, short commands, bounded waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundTaskManager,
  createTaskStore,
} from "../../dist/runtime/background-tasks.js";
import {
  readSupervised,
  spawnSupervised,
  waitSupervised,
} from "../../dist/runtime/supervised-process.js";

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

test("cancelAll stops every running task", async () => {
  const mgr = new BackgroundTaskManager();
  const sleep = `node -e "setInterval(()=>{},50)"`;
  const a = mgr.start(sleep, process.cwd(), process.env);
  const b = mgr.start(sleep, process.cwd(), process.env);
  const settled = mgr.cancelAll();
  assert.equal(settled.length, 2);
  assert.ok(settled.every((t) => t.status === "cancelled"));
  assert.deepEqual(
    mgr.list().filter((t) => t.status === "running").length,
    0,
  );
  assert.equal(a.id === b.id, false);
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
  assert.equal(after?.status, "cancelled");
  assert.equal(after?.signal, "SIGTERM");
  const done = await mgr.wait(t.id, 10000);
  assert.equal(done?.status, "cancelled");
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

test("output file keeps the full stream when the preview is capped", async () => {
  const mgr = new BackgroundTaskManager();
  const t = mgr.start(
    `node -e "process.stdout.write('y'.repeat(40000))"`,
    process.cwd(),
    process.env,
  );
  const done = await mgr.wait(t.id, 10000);
  assert.equal(done?.truncated, true);
  assert.ok(done?.outputPath);
  assert.ok(done!.output.length < 40000);
  assert.equal(readFileSync(done!.outputPath!, "utf8").length, 40000);
});

test("adopt settles a child that exited before listeners attached", async () => {
  const mgr = new BackgroundTaskManager();
  const child = spawn(
    process.env.SHELL ?? "/bin/sh",
    ["-c", "echo early"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((resolve) => child.once("exit", resolve));
  const task = mgr.adopt("early", child, "", Date.now());
  const done = await mgr.wait(task.id, 1000);
  assert.equal(done?.status, "completed");
});

test("adopt takes over a running process and captures later output", async () => {
  const mgr = new BackgroundTaskManager();
  const child = spawn(
    process.env.SHELL ?? "/bin/sh",
    ["-c", `node -e "setTimeout(()=>console.log('adopted'),80)"`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const task = mgr.adopt("adopted command", child, "seed", Date.now());
  assert.equal(task.status, "running");
  assert.ok(task.outputPath);
  assert.match(readFileSync(task.outputPath!, "utf8"), /seed/);
  const done = await mgr.wait(task.id, 5000);
  assert.equal(done?.status, "completed");
  assert.match(done?.output ?? "", /adopted/);
  assert.match(readFileSync(done!.outputPath!, "utf8"), /adopted/);
});

test("cancel propagates to produced work", async () => {
  const mgr = new BackgroundTaskManager();
  let cancelled = false;
  mgr.registerProducer("image", async (_params, registerCancel) => {
    registerCancel(() => {
      cancelled = true;
    });
    return new Promise<string>(() => {});
  });
  const job = mgr.startProducedJob("image");
  assert.equal(job.status, "running");
  assert.equal(mgr.cancel(job.id)?.status, "cancelled");
  assert.equal(cancelled, true);
});

test("empty status file is not mistaken for exit zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-status-"));
  const descriptor = spawnSupervised(
    `node -e "setTimeout(()=>{},200)"`,
    process.cwd(),
    process.env,
    dir,
  );
  assert.equal(readSupervised(descriptor).code, null);
  writeFileSync(descriptor.statusPath, "");
  assert.equal(readSupervised(descriptor).code, null);
  const keepAlive = setInterval(() => {}, 20);
  try {
    const result = await waitSupervised(descriptor, 20);
    assert.equal(result.code, 0);
  } finally {
    clearInterval(keepAlive);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("shell job reattaches to a live child after a simulated restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-shell-recovery-"));
  const first = new BackgroundTaskManager();
  first.setStore(createTaskStore("session", dir));
  const job = first.start(
    `node -e "setTimeout(()=>console.log('survived'),400)"`,
    process.cwd(),
    process.env,
  );
  assert.equal(job.status, "running");
  assert.equal(typeof job.recovery?.params?.pid, "number");

  const restarted = new BackgroundTaskManager();
  restarted.setStore(createTaskStore("session", dir));
  assert.equal(restarted.get(job.id)?.status, "running");
  const done = await restarted.wait(job.id, 5000);
  assert.equal(done?.status, "completed");
  assert.match(done?.output ?? "", /survived/);
  assert.match(readFileSync(done!.outputPath!, "utf8"), /survived/);
  rmSync(dir, { recursive: true, force: true });
});

test("reattached shell job reports the original exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-shell-code-"));
  const first = new BackgroundTaskManager();
  first.setStore(createTaskStore("session", dir));
  const job = first.start(
    `node -e "setTimeout(()=>process.exit(7),300)"`,
    process.cwd(),
    process.env,
  );
  const restarted = new BackgroundTaskManager();
  restarted.setStore(createTaskStore("session", dir));
  const done = await restarted.wait(job.id, 5000);
  assert.equal(done?.status, "failed");
  assert.equal(done?.exitCode, 7);
  rmSync(dir, { recursive: true, force: true });
});

test("generic job kinds are tracked and surfaced with their fields", async () => {
  const mgr = new BackgroundTaskManager();
  const subagent = mgr.startJob({
    kind: "subagent",
    description: "research",
    agent: "scout",
    childSessionID: "child-1",
    run: async () => "subagent done",
  });
  const image = mgr.startJob({
    kind: "image",
    title: "cover",
    path: "/tmp/cover.png",
    model: "img-1",
    run: async () => "image done",
  });
  const code = mgr.startJob({
    kind: "codemode",
    title: "transform",
    metadata: { script: "return 1" },
    run: async () => "code done",
  });
  assert.deepEqual(
    new Set(mgr.list().map((t) => t.type)),
    new Set(["subagent", "image", "codemode"]),
  );
  assert.equal(mgr.get(subagent.id)?.childSessionID, "child-1");
  assert.equal(mgr.get(image.id)?.path, "/tmp/cover.png");
  assert.equal(mgr.get(code.id)?.metadata?.script, "return 1");
  for (const job of [subagent, image, code]) {
    assert.equal((await mgr.wait(job.id, 5000))?.status, "completed");
  }
  assert.match(readFileSync(subagent.outputPath!, "utf8"), /subagent done/);
});

test("registered recoverer resumes running work across managers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-recovery-"));
  const recoverer = async (descriptor: { params?: Record<string, unknown> }) =>
    `resumed:${String(descriptor.params?.token ?? "")}`;
  const first = new BackgroundTaskManager();
  first.registerRecovery("subagent", recoverer);
  first.setStore(createTaskStore("session", dir));
  const stuck = first.startJob({
    kind: "subagent",
    description: "delegated work",
    recovery: { kind: "subagent", id: "pending", params: { token: "abc" } },
    run: () => new Promise<string>(() => {}),
  });

  const restarted = new BackgroundTaskManager();
  restarted.registerRecovery("subagent", recoverer);
  restarted.setStore(createTaskStore("session", dir));
  const resumed = await restarted.wait(stuck.id, 5000);
  assert.equal(resumed?.status, "completed");
  assert.equal(resumed?.output, "resumed:abc");
  assert.equal(resumed?.description, "delegated work");

  first.cancel(stuck.id);
  rmSync(dir, { recursive: true, force: true });
});

test("task store marks unrecoverable running work cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-store-"));
  const first = new BackgroundTaskManager();
  first.setStore(createTaskStore("session", dir));
  const finished = first.start(`echo persisted`, process.cwd(), process.env);
  await first.wait(finished.id, 10000);
  const running = first.startJob({
    kind: "image",
    path: "/tmp/pending.png",
    run: () => new Promise<string>(() => {}),
  });

  const restored = new BackgroundTaskManager();
  restored.setStore(createTaskStore("session", dir));
  assert.equal(restored.get(finished.id)?.status, "completed");
  assert.equal(restored.get(running.id)?.status, "cancelled");
  assert.equal(restored.get(running.id)?.error, "PROCESS_LOST_ON_RESTART");
  assert.equal(restored.drainCompleted().length, 0, "no stale re-notification");
  const after = restored.start(`echo after`, process.cwd(), process.env);
  assert.equal(after.id, "bg-3", "counter continues after restore");
  await restored.wait(after.id, 10000);

  first.cancel(running.id);
  rmSync(dir, { recursive: true, force: true });
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
