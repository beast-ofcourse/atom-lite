// parseJsonlEvents: crash-recovery contract for session replay. A torn
// (crash-in-progress) JSONL file must replay everything before the damage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlEvents } from "../../dist/sessions/recovery.js";
import { JsonlSessionStore } from "../../dist/sessions/store.js";

function tmpFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "recovery-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, lines.join("\n") + (lines.length ? "\n" : ""));
  return p;
}

test("parses every valid line into an event", () => {
  const events = parseJsonlEvents(
    tmpFile([
      JSON.stringify({ type: "session_started", id: "s" }),
      JSON.stringify({ type: "message", role: "user" }),
    ]),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "session_started");
});

test("a torn tail keeps all earlier valid events", () => {
  const events = parseJsonlEvents(
    tmpFile([
      JSON.stringify({ type: "session_started", id: "s" }),
      JSON.stringify({ type: "message", role: "user" }),
      '{"type": "message", "role": "assista', // crash mid-write
    ]),
  );
  assert.equal(events.length, 2, "partial line dropped, prefix kept");
});

test("a corrupt line mid-file stops replay without discarding the prefix", () => {
  const events = parseJsonlEvents(
    tmpFile([
      JSON.stringify({ type: "a" }),
      "not json",
      JSON.stringify({ type: "c" }),
    ]),
  );
  // Documented behavior: break at the first bad line, keep the prefix.
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "a");
});

test("blank lines are ignored", () => {
  const events = parseJsonlEvents(
    tmpFile(["", JSON.stringify({ type: "a" }), "   "]),
  );
  assert.equal(events.length, 1);
});

test("non-object JSON lines are skipped, not fatal", () => {
  const events = parseJsonlEvents(
    tmpFile([JSON.stringify("just a string"), JSON.stringify({ type: "a" })]),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "a");
});

test("missing and unreadable files return no events", () => {
  assert.deepEqual(parseJsonlEvents("/nonexistent/path/s.jsonl"), []);
});

test("empty file returns no events", () => {
  assert.deepEqual(parseJsonlEvents(tmpFile([])), []);
});

test("resume via the store recovers the prefix of a torn session", () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-store-"));
  const store = new JsonlSessionStore({ rootDir: dir });
  const id = "torn-session";
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({
        type: "session_started",
        id,
        workspace: process.cwd(),
        provider: "fake",
        timestamp: new Date().toISOString(),
        seq: 0,
      }),
      '{"torn":',
    ].join("\n") + "\n",
  );
  const session = store.resumeSession(id);
  assert.ok(session, "torn session still resumes");
  rmSync(dir, { recursive: true, force: true });
});
