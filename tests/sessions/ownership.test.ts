import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
import { SessionLockError } from "../../dist/sessions/lock.js";

const lockHolder = resolve("tests/fixtures/hold-session-lock.mjs");

/** Hold a lock from a real child process, like a terminal or a second CLI. */
async function holdLock(
  lockPath: string,
  sessionId: string,
): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, [lockHolder, lockPath, sessionId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolvePromise, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("locked")) {
        resolvePromise({ child, pid: child.pid ?? 0 });
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!output.includes("locked")) {
        reject(new Error(`lock holder exited before acquiring (code ${code})`));
      }
    });
  });
}

// Reason: spec (ticket 08) — one live owner per session; a live holder is
// named in the refusal and a killed holder's lock is reclaimed so a crash
// does not strand the log.
test("a live holder refuses another owner and a killed holder is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-lock-"));
  const workspace = mkdtempSync(join(tmpdir(), "session-workspace-"));
  const store = new JsonlSessionStore({ rootDir: root, lockReclaimMs: 5 });
  const created = store.create(workspace, "fake", "s1");
  created.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  await created.flush();
  created.releaseLock();

  const holder = await holdLock(join(root, "s1.jsonl.lock"), "s1");
  try {
    assert.throws(
      () => store.resume("s1"),
      (err: unknown) => {
        assert.ok(err instanceof SessionLockError);
        assert.match(err.message, new RegExp(`PID ${holder.pid}`));
        return true;
      },
    );

    // A different session in the same store is unaffected.
    const other = store.create(workspace, "fake", "s2");
    other.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second session" }],
    });
    await other.flush();
    other.releaseLock();
    const reopened = store.resume("s2");
    assert.equal(reopened?.id, "s2");
    assert.equal(reopened?.messages[0].content[0].text, "second session");
    reopened?.releaseLock();
  } finally {
    holder.child.kill("SIGKILL");
    await once(holder.child, "exit");
  }

  const reclaimed = store.resume("s1");
  assert.ok(reclaimed, "a dead holder's lock is reclaimed");
  assert.equal(reclaimed.messages[0].content[0].text, "hello");
  reclaimed.releaseLock();
});
