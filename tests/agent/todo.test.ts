import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { todoTool } from "../../dist/tools/todo.js";
import { TodoStore } from "../../dist/runtime/todos.js";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type { ModelRequest } from "../../dist/types.js";
import type { Message } from "../../dist/types.js";

class EventedSession {
  messages: Message[] = [];
  events: any[] = [];
  appendMessage(message: Message): void {
    this.messages.push(message);
  }
  appendEvent(partial: any): any {
    const ev = { timestamp: new Date().toISOString(), ...partial };
    this.events.push(ev);
    return ev;
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "recording";
  requests: ModelRequest[] = [];
  responses: any[];
  idx = 0;
  constructor(responses: any[]) {
    this.responses = responses;
  }
  async generate(request: ModelRequest): Promise<any> {
    this.requests.push(request);
    const r = this.responses[this.idx++] ?? { text: "done" };
    const toolCalls = r.toolCalls ?? [];
    return {
      message: {
        role: "assistant",
        content: r.text ? [{ type: "text", text: r.text }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage: r.usage,
    };
  }
}

test("runtime injects the task ledger after a todo write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([
    {
      toolCalls: [
        {
          id: "t1",
          name: "todo",
          arguments: {
            action: "write",
            todos: [{ content: "task A", status: "pending" }],
          },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
  });
  await runtime.runAgentTurn(
    "do task A",
    session,
    new AbortController().signal,
  );
  assert.ok(provider.requests.length >= 2);
  const second = provider.requests[1].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(second, /Task ledger/);
  assert.match(second, /task A/);
  assert.ok(session.events.some((e) => e.type === "todos_updated"));
});

test("runtime auto-captures a user task into the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
  });
  await runtime.runAgentTurn(
    "implement the feature",
    session,
    new AbortController().signal,
  );
  const first = provider.requests[0].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(first, /Task ledger/);
  assert.match(first, /implement the feature/);
});

test("runtime restores the ledger from a resumed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  session.events.push({
    type: "todos_updated",
    todos: [{ id: "T9", content: "resumed task", status: "pending" }],
  });
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
  });
  await runtime.runAgentTurn("continue", session, new AbortController().signal);
  const first = provider.requests[0].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(first, /resumed task/);
});

test("preserves a caller-supplied ledger store when restoring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  session.events.push({
    type: "todos_updated",
    todos: [{ id: "T5", content: "restored into override", status: "pending" }],
  });
  const injected = new TodoStore();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
    todoStore: injected,
  });
  await runtime.runAgentTurn("continue", session, new AbortController().signal);
  assert.equal(injected.list().length, 1);
  assert.equal(injected.list()[0].content, "restored into override");
  const first = provider.requests[0].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(first, /restored into override/);
});

test("todos persist through a real JSONL session resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const store = new JsonlSessionStore(join(dir, "sessions"));
  const created = store.create({ workspace: dir, provider: "fake", id: "s1" });
  created.appendEvent({
    type: "todos_updated",
    todos: [{ id: "T1", content: "jsonl persisted task", status: "pending" }],
  });
  created.appendMessage({
    role: "user",
    content: [{ type: "text", text: "continue" }],
  });
  await created.flush();
  const resumed = store.resume("s1");
  assert.ok(resumed);
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
  });
  await runtime.runAgentTurn(
    "continue",
    resumed!,
    new AbortController().signal,
  );
  const first = provider.requests[0].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(first, /jsonl persisted task/);
});

test("completion gate nudges while ledger items stay open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const events: any[] = [];
  const provider = new RecordingProvider([
    {
      toolCalls: [
        {
          id: "t1",
          name: "todo",
          arguments: {
            action: "write",
            todos: [{ content: "open task", status: "in_progress" }],
          },
        },
      ],
    },
    { text: "done" },
    { text: "done" },
    { text: "done" },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
    onEvent: (event: any) => events.push(event),
  });
  const result = await runtime.runAgentTurn(
    "do it",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  assert.ok(events.some((event) => event.type === "task_ledger_open"));
  // Tool call plus the bounded nudges plus the final settle.
  assert.ok(provider.requests.length >= 4);
});

test("does not nudge when the model never touches the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const events: any[] = [];
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
    onEvent: (event: any) => events.push(event),
  });
  const result = await runtime.runAgentTurn(
    "explain this",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  assert.equal(provider.requests.length, 1);
  assert.ok(!events.some((event) => event.type === "task_ledger_open"));
});

test("captures a new task that starts with a continuation word", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    mode: "yolo",
  });
  await runtime.runAgentTurn(
    "ok now fix the failing test",
    session,
    new AbortController().signal,
  );
  const first = provider.requests[0].messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  assert.match(first, /ok now fix the failing test/);
});

test("does not capture continuations or informational questions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  for (const input of ["ok", "what does this function do?"]) {
    const session = new EventedSession();
    const provider = new RecordingProvider([{ text: "done" }]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [todoTool],
      mode: "yolo",
    });
    await runtime.runAgentTurn(input, session, new AbortController().signal);
    const first = provider.requests[0].messages
      .map((m: any) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    assert.doesNotMatch(first, /Task ledger/, input);
  }
});
