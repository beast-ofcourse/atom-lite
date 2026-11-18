import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { invokeRead as read } from "./read-test-helpers.ts";

// Contract: a single sibling with the same stem and another extension is resolved in place.
test("read resolves a same-stem file with a different extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-ext-"));
  writeFileSync(join(dir, "notes.md"), "body\n");
  const result = await read(dir, { path: "notes.txt" });
  assert.equal(result.isError, undefined);
  assert.match(result.content, /notes\.md/);
  assert.match(result.content, /1: body/);
});

// Regression: look-alike Unicode characters must not turn an existing file into a miss.
test("read recovers a name differing by look-alike characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-unicode-"));
  writeFileSync(join(dir, "it’s.txt"), "curly\n");
  const result = await read(dir, { path: "it's.txt" });
  assert.equal(result.isError, undefined);
  assert.match(result.content, /1: curly/);
});

// Contract: an absolute path written from the wrong root is rerooted into the workspace.
test("read reroots a wrong-root absolute path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-root-"));
  mkdirSync(join(dir, "other"));
  writeFileSync(join(dir, "other", "a.txt"), "rerooted\n");
  const wrongRoot = join(dirname(dir), "other", "a.txt");
  assert.equal(basename(dir).startsWith("read-recover-root-"), true);
  const result = await read(dir, { path: wrongRoot });
  assert.equal(result.isError, undefined);
  assert.match(result.content, /1: rerooted/);
});

// Contract: a missing folder names the nearest existing parent so the model can see the tree.
test("read reports the nearest existing parent for a missing folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-folder-"));
  writeFileSync(join(dir, "here.txt"), "here");
  const result = await read(dir, { path: "missing/deep/file.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content, /The folder missing does not exist/);
  assert.match(result.content, /nearest folder that does is/);
});

// Contract: suggestions are ranked, capped at three, and attached to the miss.
test("read suggests at most three ranked sibling names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-suggest-"));
  for (const name of ["target.ts", "target.txt", "taget.ts", "unrelated.ts"]) writeFileSync(join(dir, name), "");
  const result = await read(dir, { path: "targat.ts" });
  assert.equal(result.isError, true);
  assert.match(result.content, /Did you mean one of these\?/);
  const suggested = result.content.split("Did you mean one of these?\n")[1].trim().split("\n");
  assert.ok(suggested.length <= 3, suggested.join(", "));
  assert.equal(suggested[0], "target.ts");
  assert.ok(!suggested.includes("unrelated.ts"));
});

// Contract: recovery never reads or suggests paths outside the workspace.
test("read rejects a recovery candidate that resolves outside the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "read-recover-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret content");
  symlinkSync(join(outside, "secret.txt"), join(dir, "alias.txt"));
  const result = await read(dir, { path: "alias.md" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content, /secret content/);

  const external = await read(dir, { path: "../etc/passwd" });
  assert.equal(external.isError, true);
  assert.match(external.content, /PATH_OUTSIDE_WORKSPACE/);
  assert.doesNotMatch(external.content, /Did you mean/);
});

// Contract: a case-only difference is ranked as the first sibling suggestion.
test("read suggests a sibling that differs only by case", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-case-"));
  writeFileSync(join(dir, "Notes.md"), "notes");
  const result = await read(dir, { path: "notes.md" });
  assert.equal(result.isError, true);
  assert.match(result.content, /Did you mean one of these\?\nNotes\.md/);
});

// Contract: an unrecoverable miss keeps the short error vocabulary.
test("read keeps FILE_NOT_FOUND when no recovery applies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-recover-miss-"));
  const result = await read(dir, { path: "nope.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content, /FILE_NOT_FOUND/);
});
