import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool, writeTool, bashTool } from "../../dist/tools/index.js";
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
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
  });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn(
    "read a.txt",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  // tool result recorded
  assert.ok(session.messages.some((m) => m.role === "tool"));
});

test("agent loop forwards streamed bash output and tool diffs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const provider = new FakeProvider([
    {
      toolCalls: [
        { id: "b1", name: "bash", arguments: { command: "echo streamed" } },
        { id: "w1", name: "write", arguments: { path: "new.txt", content: "hi\n" } },
      ],
    },
    { text: "done" },
  ]);
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [bashTool, writeTool],
    onEvent: (e) => events.push(e),
    bashConcurrency: "parallel",
  });
  const session = new InMemorySession("s1", dir);
  await runtime.runAgentTurn("go", session, new AbortController().signal);

  assert.ok(
    events.some(
      (e) =>
        e.type === "tool_output" &&
        e.toolCallId === "b1" &&
        e.stream === "stdout" &&
        e.text.includes("streamed"),
    ),
  );
  const writeResult = events.find(
    (e) => e.type === "tool_result" && e.toolCallId === "w1",
  );
  assert.deepEqual(writeResult.diff, ["+ hi"]);
});
