import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import {
  readTool,
  writeTool,
  bashTool,
  todoTool,
} from "../../dist/tools/index.js";
import { TodoStore } from "../../dist/runtime/todos.js";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
        {
          id: "w1",
          name: "write",
          arguments: { path: "new.txt", content: "hi\n" },
        },
      ],
    },
    { text: "done" },
  ]);
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [bashTool, writeTool],
    mode: "yolo",
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

test("agent loop does not stop at the old 40-iteration cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const responses = Array.from({ length: 41 }, () => ({
    toolCalls: [{ id: "c", name: "read", arguments: { path: "a.txt" } }],
  }));
  responses.push({ text: "done" } as any);
  const provider = new FakeProvider(responses as any);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
  });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
});

test("agent loop stops when session token budget is exceeded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const provider = new FakeProvider([
    { text: "hi", usage: { input: 60, output: 5 } },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    maxTokensPerSession: 50,
  });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "TOKEN_BUDGET_REACHED");
});

import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

test("mutating turn emits no checkpoint events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  const events: any[] = [];
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "new.txt", content: "hi\n" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [writeTool],
    mode: "yolo",
    onEvent: (e) => events.push(e),
  });
  const session = new InMemorySession("s1", dir);
  const sessionEvents: any[] = [];
  (session as any).appendEvent = (ev: any) => sessionEvents.push(ev);
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  // The write still ran.
  assert.ok(existsSync(join(dir, "new.txt")));
  assert.ok(
    events.some((e) => e.type === "tool_result" && e.toolCallId === "w1"),
  );
  // No checkpoint events anywhere: neither onEvent nor the session log.
  assert.ok(
    events.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in onEvent stream",
  );
  assert.ok(
    sessionEvents.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in session log",
  );
});

test("read-only turn emits no checkpoint events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  gitInit(dir);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const events: any[] = [];
  const provider = new FakeProvider([
    { toolCalls: [{ id: "r1", name: "read", arguments: { path: "a.txt" } }] },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
    onEvent: (e) => events.push(e),
  });
  const session = new InMemorySession("s1", dir);
  const sessionEvents: any[] = [];
  (session as any).appendEvent = (ev: any) => sessionEvents.push(ev);
  await runtime.runAgentTurn("go", session, new AbortController().signal);
  assert.ok(
    events.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in onEvent stream",
  );
  assert.ok(
    sessionEvents.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in session log",
  );
});

test("non-git workspace mutating turn emits no checkpoint events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-")); // not git
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "new.txt", content: "hi\n" },
        },
      ],
    },
    { text: "done" },
  ]);
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [writeTool],
    mode: "yolo",
    onEvent: (e) => events.push(e),
  });
  const session = new InMemorySession("s1", dir);
  const sessionEvents: any[] = [];
  (session as any).appendEvent = (ev: any) => sessionEvents.push(ev);
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  assert.ok(
    events.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in onEvent stream",
  );
  assert.ok(
    sessionEvents.every((e) => !String(e.type).startsWith("checkpoint")),
    "unexpected checkpoint event in session log",
  );
});

test("repeated long requests do not duplicate the task ledger", async () => {
  const longInput = "x".repeat(250);
  const provider = new FakeProvider([{ text: "done" }, { text: "done" }]);
  const todoStore = new TodoStore();
  const runtime = new AgentRuntime({
    provider,
    tools: [todoTool],
    todoStore,
  });
  const session = new InMemorySession("s1", "/tmp/ws");
  await runtime.runAgentTurn(longInput, session, new AbortController().signal);
  await runtime.runAgentTurn(longInput, session, new AbortController().signal);
  assert.equal(todoStore.list().length, 1);
});
