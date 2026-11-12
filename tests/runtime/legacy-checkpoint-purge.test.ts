import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeOrphanCheckpoints } from "../../dist/runtime/legacy-checkpoint-purge.js";

/** Build a fake checkpoint storage tree under a temp root. */
function fakeStorage(): { root: string; valid: string; orphan: string } {
  const root = mkdtempSync(join(tmpdir(), "cpurge-"));
  const hash = join(root, "workspacehash");
  const session = join(hash, "s1");
  const valid = join(session, "valid-1-1");
  const orphan = join(session, "orphan-1-2");
  mkdirSync(join(valid, "files"), { recursive: true });
  writeFileSync(join(valid, "manifest.json"), "{}");
  writeFileSync(join(valid, "files", "a.txt"), "x");
  mkdirSync(join(orphan, "files"), { recursive: true });
  writeFileSync(join(orphan, "files", "junk.bin"), Buffer.alloc(512));
  return { root, valid, orphan };
}

test("purge removes orphan captures and keeps valid ones", () => {
  const { root, valid, orphan } = fakeStorage();
  const removed = purgeOrphanCheckpoints(root);
  assert.equal(removed, 1);
  assert.equal(existsSync(orphan), false, "orphan removed");
  assert.equal(existsSync(valid), true, "valid checkpoint kept");
  assert.equal(
    existsSync(join(valid, "manifest.json")),
    true,
    "manifest untouched",
  );
});

test("purge on a missing storage root is a no-op", () => {
  const root = join(tmpdir(), `cpurge-missing-${Date.now()}`);
  assert.equal(purgeOrphanCheckpoints(root), 0);
});

test("purge leaves non-directory entries alone", () => {
  const root = mkdtempSync(join(tmpdir(), "cpurge-"));
  writeFileSync(join(root, "stray.txt"), "not a dir");
  assert.equal(purgeOrphanCheckpoints(root), 0);
  assert.equal(existsSync(join(root, "stray.txt")), true);
});
