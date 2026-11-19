import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRead as read } from "./read-test-helpers.ts";

// Contract: a successful read reports its path so instruction discovery can run.
test("read reports a successful file path for instruction discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-instructions-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "AGENTS.md"), "nested guidance");
  writeFileSync(join(dir, "sub", "file.txt"), "body");
  const seen: string[] = [];
  const result = await read(
    dir,
    { path: "sub/file.txt" },
    { onReadPath: (path) => seen.push(path) },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [join(dir, "sub", "file.txt")]);
});

// Contract: a failed read does not trigger instruction discovery.
test("read does not report a path when the read fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-instructions-miss-"));
  const seen: string[] = [];
  const result = await read(
    dir,
    { path: "missing.txt" },
    { onReadPath: (path) => seen.push(path) },
  );
  assert.equal(result.isError, true);
  assert.deepEqual(seen, []);
});

// Contract: a directory read also reports its path so its own AGENTS.md is discovered.
test("read reports a directory path for instruction discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-instructions-dir-"));
  mkdirSync(join(dir, "sub"));
  const seen: string[] = [];
  const result = await read(
    dir,
    { path: "sub" },
    { onReadPath: (path) => seen.push(path) },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [join(dir, "sub")]);
});
