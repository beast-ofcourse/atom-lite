import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import type { AgentEvent, TurnTiming } from "../../dist/agent/types.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

function timings(events: readonly AgentEvent[]): TurnTiming[] {
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "turn_timing" }> =>
        event.type === "turn_timing",
    )
    .map((event) => event.timing);
}

test("a turn emits one timing record with phases and spend", async () => {
  const events: AgentEvent[] = [];
  const provider = new FakeProvider(
    [
      {
        text: "hello there",
        usage: { input: 5, output: 2, cacheRead: 1 },
      },
    ],
    { stream: true, chunkSize: 4 },
  );
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [],
  });
  runtime.setEventSink((event) => events.push(event));
  const session = new InMemorySession("s", process.cwd());

  await runtime.runAgentTurn("hi", session, new AbortController().signal);

  const records = timings(events);
  assert.equal(records.length, 1);
  const timing = records[0];
  assert.equal(timing.modelCalls, 1);
  assert.equal(timing.inputTokens, 6);
  assert.equal(timing.cachedInputTokens, 1);
  assert.equal(timing.outputTokens, 2);
  assert.ok(timing.fixedPromptTokens > 0);
  assert.ok(timing.historyTokens > 0);
  assert.equal(timing.toolResultTokens, 0);
  assert.equal(timing.firstToolStartMs, null);
  assert.equal(timing.toolBatchMs, 0);
  assert.equal(typeof timing.serializeMs, "number");
  assert.equal(timing.queuedMs, 0);
  assert.ok(timing.requestSentAt > 0);
  assert.ok(timing.firstTokenMs !== null && timing.firstTokenMs >= 0);
  assert.ok(timing.postTurnMs >= 0);
  assert.ok(
    session.events.some((event) => event.type === "turn_timing"),
    "the timing record is persisted as a session event",
  );
  assert.equal(
    session.messages.filter((message) => message.role === "assistant").length,
    1,
  );
});

test("a tool turn records tool time and tool-result tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const events: AgentEvent[] = [];
  const provider = new FakeProvider(
    [
      {
        toolCalls: [{ id: "r1", name: "read", arguments: { path: "a.txt" } }],
      },
      { text: "done", usage: { input: 10, output: 3 } },
    ],
    { stream: true },
  );
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [
      {
        definition: { name: "read", description: "read", parameters: {} },
        execute: async (call) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { toolCallId: call.id, name: call.name, content: "hello" };
        },
      },
    ],
  });
  runtime.setEventSink((event) => events.push(event));
  const session = new InMemorySession("s", dir);

  await runtime.runAgentTurn("read", session, new AbortController().signal);

  const timing = timings(events)[0];
  assert.equal(timing.modelCalls, 2);
  assert.ok(timing.firstToolStartMs !== null && timing.firstToolStartMs >= 0);
  assert.ok(timing.toolBatchMs >= 0);
  assert.ok(timing.toolResultTokens > 0);
  assert.equal(timing.outputTokens, 3);
});

test("an aborted turn still emits a timing record", async () => {
  const events: AgentEvent[] = [];
  const provider = new FakeProvider([], { stream: true });
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [],
  });
  runtime.setEventSink((event) => events.push(event));
  const session = new InMemorySession("s", process.cwd());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() =>
    runtime.runAgentTurn("hi", session, controller.signal),
  );

  const records = timings(events);
  assert.equal(records.length, 1);
  assert.equal(records[0].modelCalls, 0);
  assert.ok(records[0].postTurnMs >= 0);
});

test("non-streaming providers populate request and first-token timings", async () => {
  const events: AgentEvent[] = [];
  const provider = new FakeProvider([
    { text: "hello", usage: { input: 10, output: 2, total: 12 } },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [],
  });
  runtime.setEventSink((event) => events.push(event));
  const session = new InMemorySession("s", process.cwd());

  await runtime.runAgentTurn("hi", session, new AbortController().signal);

  const timing = timings(events)[0];
  assert.ok(timing.requestSentAt !== null && timing.requestSentAt > 0);
  assert.ok(timing.firstTokenMs !== null && timing.firstTokenMs >= 0);
  assert.equal(timing.modelCalls, 1);
});

test("host phases and the first answer token are measured", async () => {
  const events: AgentEvent[] = [];
  const provider = new FakeProvider([{ thinking: "hmm", text: "answer" }], {
    stream: true,
    firstTokenDelayMs: 20,
    chunkDelayMs: 40,
  });
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [],
  });
  runtime.setEventSink((event) => events.push(event));
  const session = new InMemorySession("s", process.cwd());

  await runtime.runAgentTurn("hi", session, new AbortController().signal, {
    queuedMs: 15,
    preflightMs: 25,
  });

  const timing = timings(events)[0];
  assert.equal(timing.queuedMs, 15);
  assert.equal(timing.preflightMs, 25);
  assert.ok(
    timing.firstTokenMs !== null && timing.firstTokenMs >= 50,
    `first token ${timing.firstTokenMs}ms must follow the thinking delta`,
  );
});
