// Contract: the runtime is the behavioral spine for goal injection, session
// persistence, compaction continuity, the pause gate, and state events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool, todoTool, goalTool } from "../../dist/tools/index.js";
import { ContextManager } from "../../dist/context/manager.js";
import { GoalStore } from "../../dist/runtime/goal.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../dist/agent/system-prompt.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type { ModelRequest, Message } from "../../dist/types.js";

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
  private index = 0;
  private responses: any[];
  constructor(responses: any[]) {
    this.responses = responses;
  }
  async generate(request: ModelRequest): Promise<any> {
    this.requests.push(request);
    const response = this.responses[this.index++] ?? { text: "done" };
    const toolCalls = response.toolCalls ?? [];
    return {
      message: {
        role: "assistant",
        content: response.text
          ? [{ type: "text", text: response.text }]
          : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage: response.usage,
    };
  }
}

function text(request: ModelRequest): string {
  return request.messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}

test("runtime injects the goal on the next turn and every later turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "one" }, { text: "two" }]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  runtime.setGoal("Ship the feature", session as any);
  runtime.setGoalCriteria(["tests pass"], session as any);
  runtime.setGoalConstraints("no new dependencies", session as any);
  await runtime.runAgentTurn(
    "first",
    session as any,
    new AbortController().signal,
  );
  await runtime.runAgentTurn(
    "second",
    session as any,
    new AbortController().signal,
  );
  for (const request of provider.requests) {
    assert.match(text(request), /## Current goal/);
    assert.match(text(request), /Ship the feature/);
    assert.match(text(request), /tests pass/);
    assert.match(text(request), /no new dependencies/);
  }
});

test("goal is persisted as an event and restored on session resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const runtime = new AgentRuntime({
    provider: new FakeProvider([]),
    workspace: dir,
    tools: [],
  });
  runtime.setGoal("Resumed goal", session as any);
  runtime.setGoalCriteria(["criterion A"], session as any);
  assert.ok(session.events.some((event) => event.type === "goal_updated"));

  const resumed = new EventedSession();
  resumed.events.push(...session.events);
  const provider = new RecordingProvider([{ text: "done" }]);
  const next = new AgentRuntime({ provider, workspace: dir, tools: [] });
  await next.runAgentTurn(
    "continue",
    resumed as any,
    new AbortController().signal,
  );
  assert.match(text(provider.requests[0]), /Resumed goal/);
  assert.match(text(provider.requests[0]), /criterion A/);
});

test("resuming a session with no goal events starts with no goal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  await runtime.runAgentTurn(
    "fresh",
    session as any,
    new AbortController().signal,
  );
  assert.doesNotMatch(text(provider.requests[0]), /## Current goal/);
});

test("resetSessionState clears the goal and ledger for a new session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
  });
  runtime.setGoal("Old goal", session as any);
  runtime.resetSessionState(session as any);
  assert.equal(runtime.getGoal(), null);
  assert.equal(runtime.getTodos().length, 0);
  await runtime.runAgentTurn(
    "new work",
    session as any,
    new AbortController().signal,
  );
  assert.doesNotMatch(text(provider.requests[0]), /Old goal/);
});

test("goal injection works in plan mode without enabling write tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool, todoTool, goalTool],
    mode: "plan",
  });
  runtime.setGoal("Plan this", session as any);
  await runtime.runAgentTurn(
    "plan",
    session as any,
    new AbortController().signal,
  );
  assert.match(text(provider.requests[0]), /Plan this/);
  const names = (provider.requests[0].tools ?? []).map((t: any) => t.name);
  assert.ok(!names.includes("write"));
});

test("goal state events fire on mutation", () => {
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider: new FakeProvider([]),
    workspace: "/tmp",
    tools: [],
    onEvent: (event) => events.push(event),
  });
  runtime.setGoal("Track me");
  runtime.pauseGoal();
  runtime.resumeGoal();
  runtime.clearGoal();
  const states = events.filter((e) => e.type === "goal_state");
  assert.deepEqual(
    states.map((e) => e.goal?.status ?? null),
    ["active", "paused", "active", null],
  );
});

test("pause on an idle turn stops the turn before any model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "should not run" }]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  runtime.setGoal("Ship it", session as any);
  runtime.pauseGoal(session as any);
  const result = await runtime.runAgentTurn(
    "work",
    session as any,
    new AbortController().signal,
  );
  assert.equal(result, "GOAL_PAUSED");
  assert.equal(provider.requests.length, 0);
});

test("pause during a tool batch finishes in-flight work then stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([
    {
      toolCalls: [{ id: "c1", name: "todo", arguments: { action: "read" } }],
    },
    { text: "second iteration" },
  ]);
  let runtime!: AgentRuntime;
  runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    onEvent: (event: any) => {
      if (event.type === "tool_call") runtime.pauseGoal(session as any);
    },
  });
  runtime.setGoal("Ship it", session as any);
  const result = await runtime.runAgentTurn(
    "work",
    session as any,
    new AbortController().signal,
  );
  assert.equal(result, "GOAL_PAUSED");
  assert.equal(provider.requests.length, 1);
  assert.ok(session.messages.some((m) => m.role === "tool"));
  assert.equal(runtime.getGoal()?.status, "paused");
});

test("resume after a session switch continues from saved state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const original = new EventedSession();
  const runtime = new AgentRuntime({
    provider: new FakeProvider([]),
    workspace: dir,
    tools: [todoTool],
  });
  runtime.setGoal("Ship it", original as any);
  runtime.setGoalCriteria(["tests pass"], original as any);
  runtime.pauseGoal(original as any);

  const resumed = new EventedSession();
  resumed.events.push(...original.events);
  const provider = new RecordingProvider([{ text: "continuing" }]);
  const next = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
  });
  next.restoreSessionState(resumed as any);
  assert.equal(next.getGoal()?.status, "paused");
  next.resumeGoal(resumed as any);
  assert.equal(next.getGoal()?.status, "active");
  const result = await next.runAgentTurn(
    "continue",
    resumed as any,
    new AbortController().signal,
  );
  assert.equal(result, "continuing");
  assert.match(text(provider.requests[0]), /Ship it/);
});

test("goal tool completion persists completion and emits state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const events: any[] = [];
  const provider = new RecordingProvider([
    {
      toolCalls: [
        {
          id: "g1",
          name: "goal",
          arguments: { action: "complete", evidence: "tests pass" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [goalTool],
    onEvent: (event: any) => events.push(event),
  });
  runtime.setGoal("Ship it", session as any);
  runtime.setGoalCriteria(["tests pass"], session as any);
  await runtime.runAgentTurn(
    "finish",
    session as any,
    new AbortController().signal,
  );
  assert.equal(runtime.getGoal()?.status, "complete");
  const goalEvents = session.events.filter((e) => e.type === "goal_updated");
  assert.equal(goalEvents[goalEvents.length - 1].goal.status, "complete");
  assert.ok(
    events.some(
      (e) => e.type === "goal_state" && e.goal?.status === "complete",
    ),
  );
});

test("a rejected goal completion does not stop the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([
    {
      toolCalls: [
        { id: "g1", name: "goal", arguments: { action: "complete" } },
      ],
    },
    { text: "still working" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [goalTool],
  });
  runtime.setGoal("Ship it", session as any);
  runtime.setGoalCriteria(["tests pass"], session as any);
  const result = await runtime.runAgentTurn(
    "finish",
    session as any,
    new AbortController().signal,
  );
  assert.equal(result, "still working");
  assert.equal(runtime.getGoal()?.status, "active");
  assert.equal(provider.requests.length, 2);
  const toolResult = session.messages.find(
    (m: any) => m.role === "tool" && m.toolCallId === "g1",
  ) as any;
  assert.match(toolResult.content, /tests pass/);
});

test("clearing a paused goal removes the pause gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  runtime.setGoal("Ship it", session as any);
  runtime.pauseGoal(session as any);
  runtime.clearGoal(session as any);
  const result = await runtime.runAgentTurn(
    "work",
    session as any,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  assert.equal(provider.requests.length, 1);
});

test("ledger tool changes emit ledger state events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  const events: any[] = [];
  const provider = new RecordingProvider([
    {
      toolCalls: [
        {
          id: "t1",
          name: "todo",
          arguments: { action: "add", content: "new task" },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [todoTool],
    onEvent: (event: any) => events.push(event),
  });
  await runtime.runAgentTurn(
    "work",
    session as any,
    new AbortController().signal,
  );
  assert.ok(events.some((e) => e.type === "ledger_state" && e.open === 2));
});

test("recent tool-call file paths are injected as active-file context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  session.messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "editing" }],
      toolCalls: [
        {
          id: "e1",
          name: "edit",
          arguments: {
            path: "src/runtime/goal.ts",
            oldString: "a",
            newString: "b",
          },
        },
      ],
    },
  ] as Message[];
  const provider = new RecordingProvider([{ text: "done" }]);
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  await runtime.runAgentTurn(
    "continue",
    session as any,
    new AbortController().signal,
  );
  assert.match(text(provider.requests[0]), /Active files:/);
  assert.match(text(provider.requests[0]), /src\/runtime\/goal\.ts/);
});

test("manual compaction keeps the goal and mirrors one continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  session.messages = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `old message ${i}` }],
  })) as Message[];
  const events: any[] = [];
  const provider = new RecordingProvider([{ text: "manual summary" }]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    onEvent: (event: any) => events.push(event),
  });
  runtime.setGoal("Ship it", session as any);
  runtime.setGoalCriteria(["tests pass"], session as any);
  const summary = await runtime.compactSession(session as any);
  assert.equal(summary, "manual summary");
  const continuations = events.filter(
    (e) => e.type === "compaction_continuation",
  );
  assert.equal(continuations.length, 1);
  assert.match(continuations[0].text, /Goal: Ship it/);
  const summarizerInput = text(provider.requests[0]);
  assert.match(summarizerInput, /Ship it/);
  assert.match(summarizerInput, /tests pass/);
  assert.equal(runtime.getGoal()?.statement, "Ship it");
});

test("compaction keeps the goal in context and mirrors one continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const session = new EventedSession();
  session.messages = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `old message ${i}` }],
  })) as Message[];
  const events: any[] = [];
  const provider = new RecordingProvider([
    { text: "summary" },
    { text: "done" },
  ]);
  const contextManager = new ContextManager({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider,
    model: "test",
    userInstructionsPath: join(dir, "missing-AGENTS.md"),
  });
  contextManager.setForceCompact(true);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    contextManager,
    onEvent: (event: any) => events.push(event),
  });
  runtime.setGoal("Ship it", session as any);
  runtime.setGoalCriteria(["tests pass"], session as any);
  await runtime.runAgentTurn(
    "continue",
    session as any,
    new AbortController().signal,
  );

  const summarizerInput = text(provider.requests[0]);
  assert.match(summarizerInput, /Ship it/);
  assert.match(summarizerInput, /tests pass/);
  const mainInput = text(provider.requests[1]);
  assert.match(mainInput, /## Current goal/);
  const continuations = events.filter(
    (e) => e.type === "compaction_continuation",
  );
  assert.equal(continuations.length, 1);
  assert.match(continuations[0].text, /Goal: Ship it/);
  assert.match(continuations[0].text, /Success criteria: tests pass/);
  assert.match(continuations[0].text, /Do not redo completed work/);
  const mirrored = session.messages.filter(
    (m: any) =>
      typeof m.content === "string" &&
      m.content.startsWith("Continuation after compaction:"),
  );
  assert.equal(mirrored.length, 1);
});
