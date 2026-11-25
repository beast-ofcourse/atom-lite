import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool, bashTool } from "../../dist/tools/index.js";

test("partial failure keeps successful result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const provider = new FakeProvider([
    {
      toolCalls: [
        { id: "r1", name: "read", arguments: { path: "a.txt" } },
        { id: "r2", name: "read", arguments: { path: "missing.txt" } },
      ],
    },
    { text: "done" },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
  });
  const session = new InMemorySession("s", dir);
  const res = await runtime.runAgentTurn(
    "read",
    session,
    new AbortController().signal,
  );
  assert.equal(res, "done");
  const toolMsgs = session.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  const readA = toolMsgs.find((m) => m.toolCallId === "r1");
  const readMissing = toolMsgs.find((m) => m.toolCallId === "r2");
  assert.match(readA?.content ?? "", /hello/);
  assert.match(readMissing?.content ?? "", /FILE_NOT_FOUND/);
});

test("tool results reach the next model call before the whole batch finishes", async () => {
  // Reason: spec — a fast result must not wait for a slow sibling tool in the
  // same batch before the model sees it.
  const events: Array<{ at: number; event: string; name?: string }> = [];
  const started = Date.now();
  const at = () => Date.now() - started;
  const provider = new FakeProvider([
    {
      toolCalls: [
        { id: "fast", name: "fast", arguments: {} },
        { id: "slow", name: "slow", arguments: {} },
      ],
    },
    { text: "done" },
    { text: "done" },
  ]);
  const generate = provider.generate.bind(provider);
  provider.generate = async (request) => {
    events.push({ at: at(), event: "model" });
    return generate(request);
  };
  const tool = (name: string, delayMs: number) => ({
    definition: { name, description: name, parameters: {} },
    execute: async (call: any) => {
      events.push({ at: at(), event: "tool_start", name });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push({ at: at(), event: "tool_end", name });
      return { toolCallId: call.id, name, content: `${name} result` };
    },
  });
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [tool("fast", 20), tool("slow", 400)],
  });
  const session = new InMemorySession("s", process.cwd());
  const result = await runtime.runAgentTurn(
    "tools",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  const secondModelCall = events.filter((e) => e.event === "model")[1];
  const slowEnd = events.find((e) => e.event === "tool_end" && e.name === "slow");
  assert.ok(secondModelCall && slowEnd);
  assert.ok(
    secondModelCall.at < slowEnd.at,
    `second model call at ${secondModelCall.at}ms must precede slow tool end at ${slowEnd.at}ms`,
  );
});

test("cancellation stops the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const controller = new AbortController();
  const provider = new FakeProvider([
    {
      toolCalls: [
        { id: "b1", name: "bash", arguments: { command: "sleep 5" } },
      ],
    },
  ]);
  // cancel immediately
  controller.abort();
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [bashTool],
  });
  const session = new InMemorySession("s", dir);
  await assert.rejects(() =>
    runtime.runAgentTurn("run", session, controller.signal),
  );
});
