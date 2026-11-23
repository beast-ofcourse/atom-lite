import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UndoManager } from "../../dist/runtime/undo.js";
import type { Message } from "../../dist/types.js";

function gitTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "atom-undo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

test("undo restores files and message pointer, redo restores both", async () => {
  const dir = gitTempRepo();
  try {
    writeFileSync(join(dir, "file.txt"), "original\n");
    const session = {
      workspace: dir,
      messages: [] as Message[],
    };
    const manager = new UndoManager();
    await manager.captureBefore(session);
    session.messages.push(
      { role: "user", content: [{ type: "text", text: "do it" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    );
    writeFileSync(join(dir, "file.txt"), "edited\n");
    const record = await manager.commitTurn(session, { messageID: "m1" });
    assert.ok(record);
    assert.deepEqual(record!.files, ["file.txt"]);
    assert.equal(manager.hasUndo(session), true);

    await manager.undo(session);
    assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "original\n");
    assert.equal(session.messages.length, 0);
    assert.equal(manager.hasRedo(session), true);

    await manager.redo(session);
    assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "edited\n");
    assert.equal(session.messages.length, 2);
    assert.equal(manager.hasUndo(session), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing to undo or redo is reported by the predicates", () => {
  const session = { messages: [] as Message[] };
  const manager = new UndoManager();
  assert.equal(manager.hasUndo(session), false);
  assert.equal(manager.hasRedo(session), false);
});
