// Reason: spec — a read must register nearby AGENTS.md so the next context build sees it.
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
import { BackgroundTaskManager } from "../../dist/runtime/background-tasks.js";
import type { Tool } from "../../dist/tools/types.js";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { ContextManager } from "../../dist/context/manager.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";
import { tmpdir } from "node:os";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h: string) => `${h}\n- value`).join("\n\n");
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

test("agent loop injects instructions discovered by a read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-nested-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "AGENTS.md"), "nested loop guidance");
  writeFileSync(join(dir, "sub", "file.txt"), "body\n");
  const provider = new FakeProvider([
    {
      toolCalls: [
        { id: "c1", name: "read", arguments: { path: "sub/file.txt" } },
      ],
    },
    { text: "done" },
  ]);
  const contextManager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 100,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider,
    model: "fake",
    userInstructionsPath: join(dir, "missing-user-AGENTS.md"),
  });
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
    contextManager,
  });
  const session = new InMemorySession("s1", dir);
  assert.equal(
    await runtime.runAgentTurn(
      "read a file",
      session,
      new AbortController().signal,
    ),
    "done",
  );
  const built = (await contextManager.build(dir, []))
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(built, /nested loop guidance/);
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

test("agent loop retries a failed compaction and still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const contextManager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: 60,
    reserveOutputTokens: 10,
    compactAtPercent: 50,
    maxProjectInstructionBytes: 30000,
    provider: {
      id: "failing",
      generate: async () => {
        throw new Error("compaction boom");
      },
    } as any,
    model: "failing-model",
    userInstructionsPath: join(dir, "missing-AGENTS.md"),
  });
  const provider = new FakeProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    contextManager,
  });
  const session = new InMemorySession("s1", dir);
  session.messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${i} ${"x".repeat(40)}` }],
  })) as any;
  const events: any[] = [];
  (runtime as any).onEvent = (e: any) => events.push(e);
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  assert.ok(
    events.filter((e) => e.type === "context_compaction_failed").length === 1,
  );
});

test("long-horizon turns compact and continue across multiple turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-long-"));
  const contextManager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: 120,
    reserveOutputTokens: 20,
    compactAtPercent: 60,
    maxProjectInstructionBytes: 30000,
    provider: {
      id: "compact",
      generate: async () => ({
        message: {
          role: "assistant",
          content: [{ type: "text", text: VALID_SUMMARY }],
        },
        toolCalls: [],
        finishReason: "stop",
        usage: { input: 10, output: 5 },
      }),
    } as any,
    model: "compact-model",
    userInstructionsPath: join(dir, "missing-AGENTS.md"),
  });
  const provider = new FakeProvider([
    { text: "done 1" },
    { text: "done 2" },
    { text: "done 3" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    contextManager,
  });
  const session = new InMemorySession("long", dir);
  session.messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `history ${i} ${"x".repeat(60)}` }],
  })) as any;
  const events: any[] = [];
  const sessionEvents: any[] = [];
  (session as any).appendEvent = (event: any) => {
    sessionEvents.push(event);
    return event;
  };
  (runtime as any).onEvent = (event: any) => events.push(event);

  for (let i = 0; i < 3; i++) {
    const result = await runtime.runAgentTurn(
      `continue turn ${i + 1}`,
      session,
      new AbortController().signal,
    );
    assert.equal(result, `done ${i + 1}`);
  }

  assert.ok(
    sessionEvents.some((event) => event.type === "context_compacted"),
    "long-horizon run should compact at least once",
  );
  assert.ok(session.messages.length > 0);
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

test("turn cancellation stops all background tasks in the session", async () => {
  const tasks = new BackgroundTaskManager();
  const controller = new AbortController();
  const abortTool: Tool = {
    definition: {
      name: "abort",
      description: "abort the turn",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      controller.abort();
      return { toolCallId: "c2", name: "abort", content: "aborted" };
    },
  };
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "c1",
          name: "bash",
          arguments: {
            command: `node -e "setInterval(()=>{},50)"`,
            background: true,
          },
        },
      ],
    },
    { toolCalls: [{ id: "c2", name: "abort", arguments: {} }] },
    { text: "unreachable" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [bashTool, abortTool],
    backgroundTasks: tasks,
  });
  const session = new InMemorySession("s1", process.cwd());
  await assert.rejects(
    runtime.runAgentTurn("start and abort", session, controller.signal),
    /USER_CANCELLED/,
  );
  assert.ok(
    tasks.list().every((t) => t.status === "cancelled"),
    "every session background task was cancelled",
  );
});

test("background completion injects the result and resumes through steering", async () => {
  const tasks = new BackgroundTaskManager();
  const steering: string[] = [];
  const events: any[] = [];
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "c1",
          name: "bash",
          arguments: {
            command: `node -e "setTimeout(()=>console.log('bgdone'),30)"`,
            background: true,
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "c2",
          name: "bash",
          arguments: { command: `node -e "setTimeout(()=>{},200)"` },
        },
      ],
    },
    { text: "final" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: process.cwd(),
    tools: [bashTool],
    backgroundTasks: tasks,
    steeringQueue: steering,
    onEvent: (e) => events.push(e),
  });
  const session = new InMemorySession("s1", process.cwd());
  const result = await runtime.runAgentTurn(
    "start a job",
    session,
    new AbortController().signal,
  );

  assert.equal(result, "final");
  assert.ok(
    events.some((e) => e.type === "background_task_complete" && e.status === "completed"),
  );
  assert.ok(
    session.messages.some(
      (m: any) =>
        m.role === "system" &&
        String(m.content).includes("bgdone") &&
        String(m.content).includes("completed"),
    ),
  );
  assert.equal(steering.length, 0, "synthetic resume message was consumed");
});

// Contract: plain user messages, however long or repeated, never populate the
// ledger now that runtime capture is gone.
test("repeated plain requests leave the task ledger empty", async () => {
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
  assert.equal(todoStore.list().length, 0);
});
