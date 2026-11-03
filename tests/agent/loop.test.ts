import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool } from "../../dist/tools/index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent loop returns final text from a fake provider", async () => {
  const provider = new FakeProvider([{ text: "hello world" }]);
  const runtime = new AgentRuntime({ provider, tools: [] });
  const session = new InMemorySession("s1", "/tmp/ws");
  const result = await runtime.runAgentTurn(
    "say hi",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "hello world");
});

test("agent loop executes a read tool then returns final answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const provider = new FakeProvider([
    { toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }] },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn("read a.txt", session, new AbortController().signal);
  assert.equal(result, "done");
  // tool result recorded
  assert.ok(session.messages.some((m) => m.role === "tool"));
});
