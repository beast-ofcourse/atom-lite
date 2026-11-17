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

// Contract: runtime never captures user messages into the ledger, whatever
// their shape. Pins removal of the capture heuristics: only model todo-tool
// calls may create ledger items or emit ledger events.
test("runtime does not capture any user message into the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  for (const input of [
    "implement the feature",
    "ok",
    "what does this function do?",
    "read the entire repository, map every module, and write a comprehensive design document for the new feature",
  ]) {
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
    await runtime.runAgentTurn(input, session, new AbortController().signal);
    const first = provider.requests[0].messages
      .map((m: any) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    assert.doesNotMatch(first, /Task ledger/, input);
    assert.ok(
      !session.events.some((e) => e.type === "todos_updated"),
      `todos_updated emitted for: ${input}`,
    );
    assert.ok(
      !events.some((e) => e.type === "ledger_state"),
      `ledger_state emitted for: ${input}`,
    );
  }
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

// Contract: model-driven decomposition. A model-written plan and a later
// status change must appear both in the next model context and in the
// persisted ledger event, with no runtime-created item mixed in.
test("model-driven todo decomposition renders and persists subtask progress", async () => {
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
            todos: [
              { id: "T1", content: "set up the project", status: "pending" },
              { id: "T2", content: "run the test suite", status: "pending" },
              { id: "T3", content: "review the diff", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "t2",
          name: "todo",
          arguments: {
            action: "complete",
            id: "T1",
            verification: "npm test passed",
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
    "build the whole feature",
    session,
    new AbortController().signal,
  );
  assert.ok(provider.requests.length >= 3);
  const rendered = (index: number) =>
    provider.requests[index].messages
      .map((m: any) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
  const second = rendered(1);
  assert.match(second, /Task ledger/);
  assert.match(second, /set up the project/);
  assert.match(second, /run the test suite/);
  assert.match(second, /review the diff/);
  assert.match(
    rendered(2),
    /\[completed\] T1: set up the project \(verify: npm test passed\)/,
  );
  const updates = session.events.filter((e) => e.type === "todos_updated");
  assert.ok(updates.length >= 2);
  assert.deepEqual(
    updates[updates.length - 1].todos.map((t: any) => [t.id, t.status]),
    [
      ["T1", "completed"],
      ["T2", "pending"],
      ["T3", "pending"],
    ],
  );
});
