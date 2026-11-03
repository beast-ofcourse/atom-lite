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
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s", dir);
  const res = await runtime.runAgentTurn("read", session, new AbortController().signal);
  assert.equal(res, "done");
  const toolMsgs = session.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.match(toolMsgs[0].content, /hello/);
  assert.match(toolMsgs[1].content, /FILE_NOT_FOUND/);
});

test("cancellation stops the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const controller = new AbortController();
  const provider = new FakeProvider([{ toolCalls: [{ id: "b1", name: "bash", arguments: { command: "sleep 5" } }] }]);
  // cancel immediately
  controller.abort();
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [bashTool] });
  const session = new InMemorySession("s", dir);
  await assert.rejects(() => runtime.runAgentTurn("run", session, controller.signal));
});