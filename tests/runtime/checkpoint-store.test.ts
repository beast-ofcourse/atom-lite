import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../../dist/runtime/checkpoint-store.js";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function track(dir: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, c);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

test("reports unavailable outside a git worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const store = new CheckpointStore(dir, "s1");
  const avail = store.isAvailable();
  assert.equal(avail.available, false);
  assert.ok(avail.reason);
});

test("reports available inside a git worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "hello" });
  const store = new CheckpointStore(dir, "s1");
  assert.equal(store.isAvailable().available, true);
});

test("captures tracked and untracked non-ignored files, excludes ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "tracked.txt": "t", ".gitignore": "ignored.txt\n" });
  writeFileSync(join(dir, "untracked.txt"), "u");
  writeFileSync(join(dir, "ignored.txt"), "x");
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  assert.deepEqual(m.files.sort(), [".gitignore", "tracked.txt", "untracked.txt"]);
  assert.ok(!m.files.includes("ignored.txt"));
  assert.equal(m.empty, false);
});

test("records deleted tracked files as skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "gone.txt": "g" });
  rmSync(join(dir, "gone.txt"));
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  assert.ok(m.skipped.some((s) => s.path === "gone.txt" && s.reason === "deleted"));
});

test("skips symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  assert.ok(m.skipped.some((s) => s.path === "link.txt" && s.reason === "symlink"));
});

test("restore recreates deleted files and removes created ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "keep.txt": "keep" });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  // mutate: delete keep.txt, create new.txt
  rmSync(join(dir, "keep.txt"));
  writeFileSync(join(dir, "new.txt"), "new");
  const preview = store.restore(m.id);
  assert.ok(preview.restored.includes("keep.txt"));
  assert.ok(preview.removed.includes("new.txt"));
  assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(dir, "new.txt")), false);
});

test("keepUntracked preserves created files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "keep.txt": "keep" });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  writeFileSync(join(dir, "new.txt"), "new");
  store.restore(m.id, true);
  assert.equal(existsSync(join(dir, "new.txt")), true);
});

test("isAtCheckpoint detects unchanged workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  assert.equal(store.isAtCheckpoint(m.id), true);
  writeFileSync(join(dir, "a.txt"), "changed");
  assert.equal(store.isAtCheckpoint(m.id), false);
});

test("diff reports added, modified, deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "mod.txt": "old", "del.txt": "d" });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  writeFileSync(join(dir, "mod.txt"), "new");
  rmSync(join(dir, "del.txt"));
  writeFileSync(join(dir, "add.txt"), "a");
  const d = store.diff(m.id);
  const byPath = Object.fromEntries(d.map((e) => [e.path, e.status]));
  assert.equal(byPath["mod.txt"], "modified");
  assert.equal(byPath["del.txt"], "deleted");
  assert.equal(byPath["add.txt"], "added");
});

test("byte cap throws CHECKPOINT_TOO_LARGE", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "big.txt": "x".repeat(1000) });
  const store = new CheckpointStore(dir, "s1", { maxCheckpointBytes: 10 });
  assert.throws(() => store.create(1), /CHECKPOINT_TOO_LARGE/);
});

test("count cap prunes oldest", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  const store = new CheckpointStore(dir, "s1", { maxCheckpoints: 2 });
  const m1 = store.create(1);
  const m2 = store.create(2);
  const m3 = store.create(3);
  const ids = store.list().map((m) => m.id);
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(m1.id));
  assert.ok(ids.includes(m3.id));
});

test("survives process restart (list from disk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  const s1 = new CheckpointStore(dir, "s1");
  const m = s1.create(1);
  const s2 = new CheckpointStore(dir, "s1");
  assert.equal(s2.get(m.id)?.id, m.id);
  assert.equal(s2.list().length, 1);
});

test("diff falls back to HEAD when no checkpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  writeFileSync(join(dir, "a.txt"), "changed");
  const store = new CheckpointStore(dir, "s1");
  const d = store.diff();
  assert.ok(d.some((e) => e.path === "a.txt"));
});

test("previewRestore does not modify files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  track(dir, { "a.txt": "a" });
  const store = new CheckpointStore(dir, "s1");
  const m = store.create(1);
  writeFileSync(join(dir, "a.txt"), "changed");
  const before = readFileSync(join(dir, "a.txt"), "utf8");
  store.previewRestore(m.id);
  const after = readFileSync(join(dir, "a.txt"), "utf8");
  assert.equal(before, after);
});
