import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRead as read } from "./read-test-helpers.ts";

// Contract: a directory path returns a sorted listing with directories first, never a not-found error.
test("read lists a directory with directories first and a trailing separator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-"));
  mkdirSync(join(dir, "zeta"));
  mkdirSync(join(dir, "alpha"));
  writeFileSync(join(dir, "b.txt"), "b");
  writeFileSync(join(dir, "a.txt"), "a");
  symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));

  const result = await read(dir, { path: "." });
  assert.match(result.content, /^Directory: \./);
  assert.deepEqual(result.content.split("\n").slice(1), ["alpha/", "zeta/", "a.txt", "b.txt", "link.txt"]);
});

// Regression: sort raw names before adding the trailing separator, so prefix siblings stay in name order.
test("read sorts prefix-related directories by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-sort-"));
  mkdirSync(join(dir, "a-b"));
  mkdirSync(join(dir, "a"));
  const result = await read(dir, { path: "." });
  assert.deepEqual(result.content.split("\n").slice(1), ["a/", "a-b/"]);
});

// Contract: a raised output cap cannot push a directory listing past the internal 50 KiB page budget.
test("read bounds a directory listing by the internal byte budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-budget-"));
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, "x".repeat(190) + i), "");
  const result = await read(dir, { path: "." }, { maxToolOutputBytes: 100000 });
  assert.match(result.content, /Continue reading with offset/);
  assert.ok(Buffer.byteLength(result.content) <= 50 * 1024, `${Buffer.byteLength(result.content)} bytes`);
});

// Contract: directory listings page with the same continuation cursor as text reads.
test("read pages a directory listing with a continuation cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-pages-"));
  for (const name of ["f1", "f2", "f3", "f4", "f5"]) writeFileSync(join(dir, name), name);

  const first = await read(dir, { path: ".", offset: 1, limit: 2 });
  assert.match(first.content, /Directory: \. \(entries 1-2\)/);
  assert.match(first.content, /f1\nf2/);
  assert.match(first.content, /Continue reading with offset: 3/);

  const second = await read(dir, { path: ".", offset: 3, limit: 2 });
  assert.match(second.content, /f3\nf4/);
  assert.match(second.content, /Continue reading with offset: 5/);

  const last = await read(dir, { path: ".", offset: 5, limit: 2 });
  assert.match(last.content, /f5/);
  assert.doesNotMatch(last.content, /Continue reading with offset/);
});

// Contract: an empty directory reports zero entries and is not a failed read.
test("read reports an empty directory explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-empty-"));
  mkdirSync(join(dir, "empty"));
  const result = await read(dir, { path: "empty" });
  assert.match(result.content, /0 entries/);
  assert.match(result.content, /\(empty\)/);
  assert.equal(result.isError, undefined);
});

// Contract: directory reads keep the workspace boundary and stay available in plan mode.
test("read keeps containment and plan-mode access for directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-dir-safe-"));
  mkdirSync(join(dir, "sub"));
  const outside = await read(dir, { path: ".." }, { mode: "plan" });
  assert.equal(outside.isError, true);
  assert.match(outside.content, /PATH_OUTSIDE_WORKSPACE/);

  const inside = await read(dir, { path: "sub" }, { mode: "plan" });
  assert.equal(inside.isError, undefined);
  assert.match(inside.content, /^Directory: sub/);
});
