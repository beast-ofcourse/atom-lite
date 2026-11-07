import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { todoTool } from "../../dist/tools/todo.js";
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
  await runtime.runAgentTurn("do task A", session, new AbortController().signal);
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
