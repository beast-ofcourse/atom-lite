import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool, writeTool, editTool, bashTool } from "../../dist/tools/index.js";

function ctx(workspace: string) {
  return { workspace, signal: new AbortController().signal };
}

test("read returns numbered lines and hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  const r = await readTool.execute({ id: "1", name: "read", arguments: { path: "a.txt" } }, ctx(dir));
  assert.match(r.content, /1: line1/);
  assert.match(r.content, /sha256:/);
});

test("write creates file and hash guard rejects stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r1 = await writeTool.execute({ id: "1", name: "write", arguments: { path: "b.txt", content: "hi" } }, ctx(dir));
  assert.match(r1.content, /Wrote 2 bytes/);
  // new file write requires no hash; existing requires hash
  const r2 = await writeTool.execute({ id: "2", name: "write", arguments: { path: "b.txt", content: "ho", expected_hash: "bad" } }, ctx(dir));
  assert.equal(r2.isError, true);
});

test("edit exact match and ambiguous handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "c.txt"), "foo\nfoo\n");
  const r = await editTool.execute({ id: "1", name: "edit", arguments: { path: "c.txt", old_string: "foo", new_string: "bar" } }, ctx(dir));
  assert.equal(r.isError, true);
  assert.match(r.content, /EDIT_AMBIGUOUS_MATCH/);
  writeFileSync(join(dir, "d.txt"), "foo\n");
  const r2 = await editTool.execute({ id: "2", name: "edit", arguments: { path: "d.txt", old_string: "foo", new_string: "bar" } }, ctx(dir));
  assert.ok(!r2.isError);
  assert.equal(readFileSync(join(dir, "d.txt"), "utf8"), "bar\n");
});

test("edit not found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "e.txt"), "hello\n");
  const r = await editTool.execute({ id: "1", name: "edit", arguments: { path: "e.txt", old_string: "nope", new_string: "x" } }, ctx(dir));
  assert.equal(r.isError, true);
  assert.match(r.content, /EDIT_NOT_FOUND/);
});

test("bash runs command and returns output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await bashTool.execute({ id: "1", name: "bash", arguments: { command: "echo hello" } }, ctx(dir));
  assert.match(r.content, /hello/);
  assert.match(r.content, /exit_code: 0/);
});

test("path escape rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await readTool.execute({ id: "1", name: "read", arguments: { path: "../etc/passwd" } }, ctx(dir));
  assert.equal(r.isError, true);
  assert.match(r.content, /PATH_OUTSIDE_WORKSPACE/);
});