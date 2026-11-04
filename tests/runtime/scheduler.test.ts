import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolBatch, LockManager } from "../../dist/runtime/scheduler.js";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
} from "../../dist/tools/index.js";

function ctx(workspace: string) {
  return {
    workspace,
    signal: new AbortController().signal,
    maxBashTimeMs: 5000,
    maxToolOutputBytes: 30000,
  };
}

test("results returned in original call order even if completion differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "A");
  writeFileSync(join(dir, "b.txt"), "B");
  const calls = [
    { id: "1", name: "read", arguments: { path: "a.txt" } },
    { id: "2", name: "read", arguments: { path: "b.txt" } },
  ];
  const toolMap = new Map([
    ["read", readTool],
    ["write", writeTool],
    ["bash", bashTool],
  ]);
  const res = await executeToolBatch(
    calls as any,
    toolMap,
    ctx(dir),
    4,
    new AbortController().signal,
  );
  assert.equal(res[0].toolCallId, "1");
  assert.equal(res[1].toolCallId, "2");
  assert.match(res[0].content, /A/);
  assert.match(res[1].content, /B/);
});

test("bash barrier serializes with file ops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "f.txt"), "start");
  const calls = [
    { id: "1", name: "read", arguments: { path: "f.txt" } },
    { id: "2", name: "bash", arguments: { command: "echo bash-ran" } },
    { id: "3", name: "read", arguments: { path: "f.txt" } },
  ];
  const toolMap = new Map([
    ["read", readTool],
    ["write", writeTool],
    ["bash", bashTool],
  ]);
  const res = await executeToolBatch(
    calls as any,
    toolMap,
    ctx(dir),
    4,
    new AbortController().signal,
  );
  assert.equal(res.length, 3);
  assert.match(res[1].content, /bash-ran/);
});

test("conflicting edits to same file serialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "x.txt"), "hello");
  const calls = [
    {
      id: "1",
      name: "edit",
      arguments: { path: "x.txt", old_string: "hello", new_string: "world" },
    },
    {
      id: "2",
      name: "edit",
      arguments: { path: "x.txt", old_string: "world", new_string: "done" },
    },
  ];
  const toolMap = new Map([
    ["read", readTool],
    ["write", writeTool],
    ["edit", editTool],
    ["bash", bashTool],
  ]);
  const res = await executeToolBatch(
    calls as any,
    toolMap,
    ctx(dir),
    4,
    new AbortController().signal,
  );
  assert.ok(!res[0].isError);
  assert.ok(!res[1].isError);
  assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "done");
});

function concurrentBashTool(counter: { active: number; max: number }) {
  return {
    definition: { name: "bash", description: "fake", parameters: {} },
    async execute(call: any) {
      counter.active++;
      counter.max = Math.max(counter.max, counter.active);
      await new Promise((r) => setTimeout(r, 30));
      counter.active--;
      return { toolCallId: call.id, name: "bash", content: "ok" };
    },
  } as any;
}

test("bash concurrency is serial by default and parallel when opted in", async () => {
  const calls = [
    { id: "1", name: "bash", arguments: { command: "one" } },
    { id: "2", name: "bash", arguments: { command: "two" } },
  ];
  const dir = mkdtempSync(join(tmpdir(), "ws-"));

  const serial = { active: 0, max: 0 };
  await executeToolBatch(
    calls as any,
    new Map([["bash", concurrentBashTool(serial)]]),
    ctx(dir),
    4,
    new AbortController().signal,
  );
  assert.equal(serial.max, 1);

  const parallel = { active: 0, max: 0 };
  await executeToolBatch(
    calls as any,
    new Map([["bash", concurrentBashTool(parallel)]]),
    ctx(dir),
    4,
    new AbortController().signal,
    undefined,
    "parallel",
  );
  assert.equal(parallel.max, 2);
});

test("parallel bash barrier still excludes file operations", async () => {
  const lm = new LockManager();
  const signal = new AbortController().signal;
  const releaseBash = await lm.acquireGlobalBarrier(signal);
  const secondBash = await lm.acquireGlobalBarrier(signal);

  let fileAcquired = false;
  const fileLock = lm.acquireWrite("/tmp/atom-lite-lock-test", signal).then((release) => {
    fileAcquired = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fileAcquired, false);

  releaseBash();
  secondBash();
  const releaseFile = await fileLock;
  assert.equal(fileAcquired, true);
  releaseFile();
});
