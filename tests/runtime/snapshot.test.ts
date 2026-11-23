import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot } from "../../dist/runtime/snapshot.js";

function gitTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "atom-snap-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

test("capture, files, diff and restore round-trip a tracked file", async () => {
  const dir = gitTempRepo();
  try {
    writeFileSync(join(dir, "file.txt"), "before\n");
    const before = await Snapshot.capture(dir);
    assert.ok(before);

    writeFileSync(join(dir, "file.txt"), "after\n");
    const after = await Snapshot.capture(dir);
    assert.ok(after);
    assert.notEqual(before, after);

    const files = await Snapshot.files({ from: before!, to: after!, workspace: dir });
    assert.deepEqual(files, ["file.txt"]);

    const diffs = await Snapshot.diff({
      from: before!,
      to: after!,
      workspace: dir,
    });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, "file.txt");
    assert.match(diffs[0].diff, /\+after/);

    await Snapshot.restore({
      files: new Map([["file.txt", before!]]),
      workspace: dir,
    });
    assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "before\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore removes a file absent from the snapshot tree", async () => {
  const dir = gitTempRepo();
  try {
    const before = await Snapshot.capture(dir);
    assert.ok(before);
    writeFileSync(join(dir, "new.txt"), "created\n");
    const after = await Snapshot.capture(dir);
    assert.ok(after);
    const files = await Snapshot.files({ from: before!, to: after!, workspace: dir });
    assert.deepEqual(files, ["new.txt"]);
    await Snapshot.restore({
      files: new Map([["new.txt", before!]]),
      workspace: dir,
    });
    assert.equal(existsSync(join(dir, "new.txt")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture returns undefined outside a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nogit-"));
  try {
    assert.equal(await Snapshot.capture(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
