import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolBatch } from "../../dist/runtime/scheduler.js";
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
