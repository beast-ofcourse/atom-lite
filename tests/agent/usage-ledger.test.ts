import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

const noopTool = {
  definition: { name: "noop", description: "noop", parameters: {} },
  execute: async () => ({
    toolCallId: "call-1",
    name: "noop",
    content: "SECRET TOOL OUTPUT",
  }),
};

test("one ledger record per model call, including tool-call turns", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [{ id: "call-1", name: "noop", arguments: {} }],
      usage: { input: 11, output: 3, total: 14 },
    },
    { text: "SECRET ANSWER", usage: { input: 22, output: 5, total: 27 } },
  ]);
  const records: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    model: "chosen-model",
    workspace: "/tmp/ws",
    tools: [noopTool],
    usageLedger: { record: (r: any) => records.push(r) },
  } as any);
  const session = new InMemorySession("sess-42", "/tmp/ws");
  const result = await runtime.runAgentTurn(
    "SECRET USER INPUT",
    session,
    new AbortController().signal,
    { requestId: "req-42" },
  );

  assert.equal(result, "SECRET ANSWER");
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.sessionId, "sess-42");
    assert.equal(record.requestId, "req-42");
    assert.equal(record.provider, "fake");
    assert.equal(record.model, "chosen-model");
    assert.equal(typeof record.timestamp, "string");
  }
  assert.deepEqual(records[0].usage, { input: 11, output: 3, total: 14 });
  assert.deepEqual(records[1].usage, { input: 22, output: 5, total: 27 });

  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("SECRET"));
});

test("ledger presence does not alter output, budget events, or usage", async () => {
  for (const withLedger of [false, true]) {
    const events: any[] = [];
    const provider = new FakeProvider([
      { text: "ok", usage: { input: 60, output: 5 } },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: "/tmp/ws",
      tools: [],
      maxTokensPerTurn: 10,
      onEvent: (e) => events.push(e),
      usageLedger: withLedger ? { record: () => undefined } : undefined,
    });
    const session = new InMemorySession("sess-1", "/tmp/ws");
    const result = await runtime.runAgentTurn(
      "hi",
      session,
      new AbortController().signal,
    );

    assert.equal(result, "ok");
    assert.ok(
      events.some((e) => e.type === "budget_warning" && e.scope === "turn"),
    );
    assert.ok(
      events.some(
        (e) => e.type === "usage" && e.input === 60 && e.output === 5,
      ),
    );
  }
});
