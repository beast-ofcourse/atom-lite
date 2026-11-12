// Session-log replay tolerance for historical checkpoint events (spec §2.4).
// Every session JSONL written before checkpoint removal may contain
// `checkpoint_created` / `checkpoint_failed` / `checkpoint_unavailable` /
// `checkpoint_restored` events interleaved with normal ones. Resuming such a
// session must replay silently (no error, no lost normal messages) even after
// the runtime stops emitting those event types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../../dist/sessions/store.js";

const id = "legacy-checkpoint-session";
const workspace = process.cwd();
const ts = new Date().toISOString();

function legacyEvent(seq: number, type: string, extra: object = {}): string {
  return JSON.stringify({
    type,
    timestamp: ts,
    sessionId: id,
    seq,
    ...extra,
  });
}

test("resuming an old session with historical checkpoint events replays silently and completely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-replay-"));
  try {
    // Hand-written synthetic log in the exact shape old sessions were written:
    // checkpoint events interleaved between normal message events, each with
    // the fields the legacy agent loop recorded.
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        legacyEvent(0, "session_started", { workspace, provider: "fake" }),
        legacyEvent(1, "user_message", {
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        legacyEvent(2, "checkpoint_created", { checkpointId: "cp-1" }),
        legacyEvent(3, "assistant_message", {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        }),
        legacyEvent(4, "checkpoint_failed", { reason: "disk full" }),
        legacyEvent(5, "checkpoint_unavailable", {
          reason: "not a git repository",
        }),
        legacyEvent(6, "tool_result", {
          toolCallId: "t1",
          name: "read",
          content: "file body",
          isError: false,
        }),
        legacyEvent(7, "checkpoint_restored", { checkpointId: "cp-1" }),
        legacyEvent(8, "session_ended"),
      ].join("\n") + "\n",
    );

    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let resumed;
    try {
      const store = new JsonlSessionStore(dir);
      resumed = store.resume(id);
    } finally {
      console.error = originalConsoleError;
    }

    assert.ok(resumed, "old session with checkpoint events still resumes");
    assert.deepEqual(
      errors,
      [],
      "replay must be silent: no console.error from legacy event types",
    );
    // Completeness: every normal message survives, in order, contents intact.
    assert.deepEqual(
      resumed.messages.map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(resumed.messages[0].content[0].text, "hi");
    assert.equal(resumed.messages[1].content[0].text, "hello");
    assert.equal(resumed.messages[2].content, "file body");
    // Nothing was dropped from the event log, including the legacy events.
    assert.equal(resumed.events.length, 9);
    assert.ok(
      resumed.events.some((e) => e.type === "checkpoint_created") &&
        resumed.events.some((e) => e.type === "checkpoint_restored"),
    );
    // The session stays usable after replay: new appends continue the log.
    resumed.appendEvent({ type: "session_resumed", from: id });
    await resumed.flush();
    const reopened = new JsonlSessionStore(dir).resume(id);
    assert.ok(reopened);
    assert.equal(reopened.messages.length, 3);
    assert.ok(reopened.events.some((e) => e.type === "session_resumed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
