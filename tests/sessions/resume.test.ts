import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
import {
  providerSwitchNotice,
  sessionHistoryLines,
  sessionSelectionFromEvents,
} from "../../dist/sessions/history.js";

async function withStore(run: (store: JsonlSessionStore) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-sessions-"));
  try {
    await run(new JsonlSessionStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resuming restores retained messages and the event log", async () => {
  await withStore(async (store) => {
    const created = store.create({ workspace: "/w", provider: "fake", id: "s1" });
    created.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    created.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    });
    created.appendMessage({
      role: "tool",
      toolCallId: "t1",
      name: "read",
      content: "file contents",
    });
    await created.flush();

    const resumed = store.resume("s1");
    assert.ok(resumed);
    assert.equal(resumed.messages.length, 3);
    assert.equal(resumed.messages[0].role, "user");

    resumed.appendEvent({ type: "session_resumed", from: "s0" });
    await resumed.flush();
    const reopened = store.resume("s1");
    assert.ok(reopened);
    const resumeEvent = reopened.events.find(
      (event) => event.type === "session_resumed",
    );
    assert.equal(resumeEvent?.from, "s0");
    assert.equal(reopened.messages.length, 3);
  });
});

test("resuming preserves system messages", async () => {
  await withStore(async (store) => {
    const created = store.create({ workspace: "/w", provider: "fake", id: "sys1" });
    created.appendMessage({ role: "system", content: "system note" });
    await created.flush();

    const resumed = store.resume("sys1");
    assert.ok(resumed);
    assert.equal(resumed.messages.length, 1);
    assert.equal(resumed.messages[0].role, "system");
    assert.equal(resumed.messages[0].content, "system note");
  });
});

test("session index derives titles, message counts, and search text", async () => {
  await withStore(async (store) => {
    const created = store.create({ workspace: "/w", provider: "fake", id: "s1" });
    created.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first user message" }],
    });
    created.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "assistant reply" }],
    });
    await created.flush();

    let [summary] = store.list("/w");
    assert.equal(summary.title, "first user message");
    assert.equal(summary.messageCount, 2);
    assert.match(summary.searchText ?? "", /assistant reply/);

    created.appendEvent({ type: "session_renamed", title: "renamed session" });
    await created.flush();
    [summary] = store.list("/w");
    assert.equal(summary.title, "renamed session");
  });
});

test("listing is scoped by workspace", async () => {
  await withStore(async (store) => {
    const sa = store.create({ workspace: "/a", provider: "fake", id: "a" });
    const sb = store.create({ workspace: "/b", provider: "fake", id: "b" });
    await sa.flush();
    await sb.flush();
    assert.deepEqual(
      store.list("/a").map((summary) => summary.id),
      ["a"],
    );
    assert.equal(store.list().length, 2);
  });
});

test("history lines render retained messages without system prompts", () => {
  const lines = sessionHistoryLines([
    { role: "system", content: "prompt scaffolding" },
    { role: "user", content: [{ type: "text", text: "find the bug" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "looking" }],
      toolCalls: [{ id: "t1", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "tool", toolCallId: "t1", name: "read", content: "file body" },
  ]);
  assert.deepEqual(lines, [
    "> find the bug",
    "looking",
    '⚙ read {"path":"a.ts"}',
    "[read] file body",
  ]);
  assert.ok(!lines.some((line) => line.includes("prompt scaffolding")));
});

test("selection follows the newest provider/model event", () => {
  const selection = sessionSelectionFromEvents([
    {
      type: "session_started",
      timestamp: "t",
      sessionId: "s",
      seq: 1,
      provider: "fake",
    },
    {
      type: "model_switched",
      timestamp: "t",
      sessionId: "s",
      seq: 2,
      provider: "openai",
      model: "gpt-4o",
    },
  ]);
  assert.deepEqual(selection, { provider: "openai", model: "gpt-4o" });
});

test("provider or model differences produce a switch offer", () => {
  assert.match(
    providerSwitchNotice(
      { provider: "openai", model: "gpt-4o" },
      { provider: "fake", model: "fake-model" },
    ) ?? "",
    /used fake\/fake-model.*Run \/model or \/provider/,
  );
  assert.match(
    providerSwitchNotice(
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
    ) ?? "",
    /Run \/model to switch/,
  );
  assert.equal(
    providerSwitchNotice(
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o" },
    ),
    undefined,
  );
});
