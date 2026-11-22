import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool, bashTool } from "../../dist/tools/index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function dirWithFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cm-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("Code Mode executes a tool and returns only its final result", async () => {
  const dir = dirWithFiles({ "a.txt": "hello\n" });
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: { code: "const r = await tools.read({ path: 'a.txt' }); return r.split('\\n')[1].trim().toUpperCase();" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn("use code mode", session, new AbortController().signal);
  assert.equal(result, "done");
  const toolResult = session.messages.find((m) => m.role === "tool" && m.name === "execute");
  assert.ok(toolResult);
  assert.equal(toolResult.content, '"1: HELLO"');
});

test("Code Mode runs tool calls in parallel", async () => {
  const dir = dirWithFiles({ "a.txt": "A", "b.txt": "B" });
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: {
            code: "const [a, b] = await Promise.all([tools.read({ path: 'a.txt' }), tools.read({ path: 'b.txt' })]); return a + b;",
          },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s1", dir);
  await runtime.runAgentTurn("parallel", session, new AbortController().signal);
  const toolResult = session.messages.find((m) => m.role === "tool" && m.name === "execute");
  assert.ok(toolResult?.content.includes("A"));
  assert.ok(toolResult?.content.includes("B"));
});

test("Code Mode reports tool errors", async () => {
  const dir = dirWithFiles({});
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: { code: "return await tools.read({ path: 'missing.txt' });" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s1", dir);
  await runtime.runAgentTurn("error", session, new AbortController().signal);
  const toolResult = session.messages.find((m) => m.role === "tool" && m.name === "execute");
  assert.ok(toolResult);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /Code Mode failed/);
});

test("Code Mode respects persona permissions", async () => {
  const dir = dirWithFiles({ "a.txt": "secret" });
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: { code: "return await tools.read({ path: 'a.txt' });" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
    persona: { name: "restricted", permissions: { read: { "*": "deny" } } } as any,
  });
  const session = new InMemorySession("s1", dir);
  await runtime.runAgentTurn("perm", session, new AbortController().signal);
  const toolResult = session.messages.find((m) => m.role === "tool" && m.name === "execute");
  assert.ok(toolResult);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content, /PERSONA_PERMISSION_DENIED|Code Mode failed/);
});

test("Code Mode cancellation aborts the run", async () => {
  const dir = dirWithFiles({});
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: { code: "return await tools.bash({ command: 'sleep 5' });" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [bashTool],
    mode: "yolo",
  });
  const session = new InMemorySession("s1", dir);
  const controller = new AbortController();
  const promise = runtime.runAgentTurn("cancel", session, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /USER_CANCELLED/);
});

test("Code Mode keeps intermediate tool results out of the session", async () => {
  const dir = dirWithFiles({ "a.txt": "hello" });
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "e1",
          name: "execute",
          arguments: { code: "const r = await tools.read({ path: 'a.txt' }); return r.split('\\n')[1].trim();" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [readTool] });
  const session = new InMemorySession("s1", dir);
  await runtime.runAgentTurn("context", session, new AbortController().signal);
  const tools = session.messages.filter((m) => m.role === "tool").map((m) => m.name);
  assert.deepEqual(tools, ["execute"]);
});

test("Code Mode is listed as a model tool", () => {
  const runtime = new AgentRuntime({ provider: new FakeProvider([]), tools: [readTool] });
  const defs = runtime["tools"].map((tool: any) => tool.definition.name);
  assert.ok(defs.includes("execute"));
  assert.ok(defs.includes("read"));
});
