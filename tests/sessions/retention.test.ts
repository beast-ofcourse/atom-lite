// sessions.enabled + retentionDays wiring (regression: these config fields
// were parsed but silently ignored).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../../dist/sessions/store.js";

function makeStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "retention-"));
}

function seedSession(dir: string, id: string, mtimeDaysAgo: number): void {
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(
    p,
    JSON.stringify({
      type: "session_started",
      id,
      workspace: "/nowhere",
      provider: "fake",
      timestamp: new Date().toISOString(),
      seq: 0,
    }) + "\n",
  );
  const then = new Date(Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000);
  utimesSync(p, then, then);
}

test("pruneOldSessions deletes only files older than the retention window", () => {
  const dir = makeStoreDir();
  seedSession(dir, "old", 40);
  seedSession(dir, "recent", 2);
  const store = new JsonlSessionStore({ rootDir: dir });
  const removed = store.pruneOldSessions(30);
  assert.deepEqual(removed.sort(), ["old"]);
  assert.equal(existsSync(join(dir, "old.jsonl")), false);
  assert.equal(existsSync(join(dir, "recent.jsonl")), true);
});

test("pruneOldSessions with no old files removes nothing", () => {
  const dir = makeStoreDir();
  seedSession(dir, "a", 1);
  const store = new JsonlSessionStore({ rootDir: dir });
  assert.deepEqual(store.pruneOldSessions(30), []);
  assert.equal(readdirSync(dir).length, 1);
});

test("pruneOldSessions on an unreadable root is a no-op", () => {
  // Constructed directly (the constructor would mkdir and throw on an
  // impossible path); readdirSync fails and the prune must return no ids.
  const store = Object.create(JsonlSessionStore.prototype) as JsonlSessionStore;
  (store as unknown as { rootDir: string }).rootDir = "/nonexistent-root-xyz";
  assert.deepEqual(store.pruneOldSessions(30), []);
});

test("an impossible store root fails loudly at construction", () => {
  // A regular file cannot become a directory; the store must not swallow it.
  const file = join(makeStoreDir(), "blocker");
  writeFileSync(file, "x");
  assert.throws(
    () => new JsonlSessionStore({ rootDir: join(file, "sub") }),
    /ENOTDIR|EEXIST/,
  );
});

test("listed sessions include pruning-relevant metadata", () => {
  const dir = makeStoreDir();
  seedSession(dir, "s1", 0);
  const store = new JsonlSessionStore({ rootDir: dir });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "s1");
  assert.ok(list[0].updatedAt);
});
