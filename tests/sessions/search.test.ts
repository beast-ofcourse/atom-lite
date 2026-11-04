import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "../../dist/sessions/events.js";
import {
  formatSessionList,
  formatSessionSearch,
  searchSessions,
  sessionMessageCount,
  sessionSearchText,
  sessionTitleFromEvents,
} from "../../dist/sessions/search.js";

function event(
  type: string,
  fields: Record<string, unknown> = {},
): SessionEvent {
  return {
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "s1",
    seq: 1,
    ...fields,
  };
}

function user(content: string): SessionEvent {
  return event("user_message", { content });
}

function assistant(content: string): SessionEvent {
  return event("assistant_message", { content });
}

test("title comes from the first user message", () => {
  const events = [
    event("session_started", { provider: "fake" }),
    user("  Fix   the login\nbug "),
    user("later message"),
  ];
  assert.equal(sessionTitleFromEvents(events), "Fix the login bug");
});

test("session_renamed overrides the first user message", () => {
  const events = [
    user("old title"),
    event("session_renamed", { title: "Release checklist" }),
    event("session_renamed", { title: "Final release checklist" }),
  ];
  assert.equal(sessionTitleFromEvents(events), "Final release checklist");
});

test("title falls back to (untitled) and truncates long text", () => {
  assert.equal(sessionTitleFromEvents([]), "(untitled)");
  const long = sessionTitleFromEvents([user("x".repeat(200))]);
  assert.ok(long.length <= 80);
  assert.ok(long.endsWith("…"));
});

test("message count covers retained user, assistant, and tool messages", () => {
  const events = [
    event("session_started"),
    user("one"),
    assistant("two"),
    event("tool_result", { content: "three" }),
    event("session_renamed", { title: "renamed" }),
  ];
  assert.equal(sessionMessageCount(events), 3);
});

test("search text includes messages, titles, and rename events", () => {
  const text = sessionSearchText([
    user("deploy the app"),
    assistant("deployed"),
    event("session_renamed", { title: "release notes" }),
  ]);
  assert.match(text, /deploy the app/);
  assert.match(text, /deployed/);
  assert.match(text, /release notes/);
});

const SUMMARIES = [
  {
    id: "a",
    workspace: "/home/me/project",
    provider: "kilo",
    updatedAt: "2026-01-02T00:00:00.000Z",
    title: "Deploy notes",
    messageCount: 4,
    searchText: "deploy the api\nthe deploy succeeded\n/home/me/project\nkilo",
  },
  {
    id: "b",
    workspace: "/home/me/other",
    provider: "openai",
    updatedAt: "2026-01-03T00:00:00.000Z",
    title: "Unrelated work",
    messageCount: 2,
    searchText: "something else\ndeploy is mentioned only in the body",
  },
  {
    id: "c",
    workspace: "/home/me/project",
    provider: "kilo",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: "Billing",
    messageCount: 9,
    searchText: "invoice totals",
  },
];

test("search ranks title matches above content matches", () => {
  const results = searchSessions(SUMMARIES, "deploy");
  assert.deepEqual(
    results.map((entry) => entry.id),
    ["a", "b"],
  );
});

test("search matches workspace text and adds a snippet for content hits", () => {
  const workspaceHit = searchSessions(SUMMARIES, "other");
  assert.deepEqual(
    workspaceHit.map((entry) => entry.id),
    ["b"],
  );

  const [hit] = searchSessions(SUMMARIES, "mentioned");
  assert.equal(hit.id, "b");
  assert.match(hit.snippet ?? "", /mentioned/);
});

test("empty search keeps the input order and copies entries", () => {
  const results = searchSessions(SUMMARIES, "  ");
  assert.deepEqual(
    results.map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.notEqual(results[0], SUMMARIES[0]);
});

test("session list output is stable tab-separated text", () => {
  const output = formatSessionList(SUMMARIES);
  const lines = output.split("\n");
  assert.deepEqual(lines[0].split("\t"), [
    "ID",
    "TITLE",
    "UPDATED",
    "PROVIDER",
    "MESSAGES",
    "WORKSPACE",
  ]);
  assert.deepEqual(lines[1].split("\t"), [
    "a",
    "Deploy notes",
    "2026-01-02T00:00:00.000Z",
    "kilo",
    "4",
    "/home/me/project",
  ]);
});

test("search output appends a MATCH column", () => {
  const [hit] = searchSessions(SUMMARIES, "mentioned");
  const output = formatSessionSearch([hit]);
  const lines = output.split("\n");
  assert.equal(lines[0].split("\t").at(-1), "MATCH");
  assert.match(lines[1], /mentioned/);
});

test("tab and newline characters are flattened inside cells", () => {
  const output = formatSessionList([
    {
      id: "x\ty",
      workspace: "/w\nz",
      provider: "fake",
      title: "a\tb",
      updatedAt: "now",
    },
  ]);
  for (const line of output.split("\n")) {
    assert.equal(line.split("\t").length, 6);
  }
});
