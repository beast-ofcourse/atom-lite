import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { ContextManager } from "../../dist/context/manager.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import type { AgentPersona } from "../../dist/agents/registry.js";

interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

class ScriptedProvider {
  readonly id = "scripted";
  readonly model = "test-model";
  readonly requests: any[] = [];
  private responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[]) {
    this.responses = [...responses];
  }

  async generate(request: any) {
    this.requests.push(request);
    const next = this.responses.shift() ?? { text: "done" };
    return {
      message: {
        role: "assistant",
        content: next.text ? [{ type: "text", text: next.text }] : undefined,
        toolCalls: next.toolCalls,
      },
      toolCalls: next.toolCalls ?? [],
      finishReason: next.toolCalls?.length ? "tool_calls" : "stop",
    };
  }
}

function persona(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: "reviewer",
    description: "Review code.",
    mode: "primary",
    temperature: 0.1,
    permissions: {},
    body: "Review for correctness.",
    source: "bundled",
    path: "/agents/reviewer.md",
    ...overrides,
  };
}

function manager(prompt = "Base tool policy."): ContextManager {
  return new ContextManager({
    systemPrompt: prompt,
    maxInputTokens: null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: new ScriptedProvider([]) as any,
    model: "test-model",
  });
}

function systemText(request: any): string {
  return request.messages
    .filter((message: any) => message.role === "system")
    .map((message: any) => message.content)
    .join("\n");
}

test("runtime applies persona prompt and temperature to the model turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-persona-"));
  try {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [],
      contextManager: manager(),
      persona: persona(),
    });
    await runtime.runAgentTurn(
      "hi",
      new InMemorySession("s", dir),
      new AbortController().signal,
    );

    assert.equal(provider.requests.length, 1);
    const system = systemText(provider.requests[0]);
    assert.match(system, /Base tool policy\./);
    assert.match(system, /Active persona: reviewer/);
    assert.match(system, /Review for correctness\./);
    assert.equal(provider.requests[0].options.temperature, 0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setPersona recomposes the prompt and preserves conversation history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-persona-"));
  try {
    const provider = new ScriptedProvider([
      { text: "first" },
      { text: "second" },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [],
      contextManager: manager(),
      persona: persona({
        name: "planner",
        body: "Plan first.",
        temperature: 0.4,
      }),
    });
    const session = new InMemorySession("s", dir);
    await runtime.runAgentTurn(
      "first request",
      session,
      new AbortController().signal,
    );
    const before = session.messages.length;

    runtime.setPersona(
      persona({ name: "architect", body: "Design first.", temperature: 0.2 }),
    );
    assert.equal(session.messages.length, before);

    await runtime.runAgentTurn(
      "second request",
      session,
      new AbortController().signal,
    );
    const latest = provider.requests.at(-1);
    const system = systemText(latest);
    assert.match(system, /Active persona: architect/);
    assert.match(system, /Design first\./);
    assert.ok(!system.includes("Plan first."));
    assert.equal(latest.options.temperature, 0.2);
    assert.ok(session.messages.some((message: any) => message.role === "user"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function bashTool(counter: { calls: number }) {
  return {
    definition: {
      name: "bash",
      description: "run a command",
      parameters: { type: "object", properties: {} },
    },
    async execute(call: any) {
      counter.calls++;
      return { toolCallId: call.id, name: "bash", content: "ran" };
    },
  };
}

test("persona deny blocks a tool before execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-persona-"));
  try {
    const counter = { calls: 0 };
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "rm -rf /" } },
        ],
      },
      { text: "done" },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [bashTool(counter) as any],
      contextManager: manager(),
      persona: persona({ permissions: { bash: { "*": "deny" } } }),
    });
    await runtime.runAgentTurn(
      "run it",
      new InMemorySession("s", dir),
      new AbortController().signal,
    );

    assert.equal(counter.calls, 0);
    const toolMessage = provider.requests
      .flatMap((request) => request.messages)
      .find((message: any) => message.role === "tool");
    assert.match(toolMessage.content, /PERSONA_PERMISSION_DENIED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persona ask routes through the approval handler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-persona-"));
  try {
    const counter = { calls: 0 };
    const prompts: string[] = [];
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "echo hi" } },
        ],
      },
      { text: "done" },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [bashTool(counter) as any],
      contextManager: manager(),
      persona: persona({ permissions: { bash: { "*": "ask" } } }),
      approvals: {
        mode: "ask",
        isTrusted: () => false,
        trustSession: () => {},
        nonInteractive: false,
        handler: async (request) => {
          prompts.push(request.command);
          return "approve";
        },
      },
    });
    await runtime.runAgentTurn(
      "run it",
      new InMemorySession("s", dir),
      new AbortController().signal,
    );

    assert.equal(counter.calls, 1);
    assert.match(prompts[0], /bash: echo hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persona allow runs the tool without an approval handler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-persona-"));
  try {
    const counter = { calls: 0 };
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "git status" } },
        ],
      },
      { text: "done" },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [bashTool(counter) as any],
      contextManager: manager(),
      persona: persona({
        permissions: { bash: { "*": "ask", "git status*": "allow" } },
      }),
    });
    await runtime.runAgentTurn(
      "run it",
      new InMemorySession("s", dir),
      new AbortController().signal,
    );

    assert.equal(counter.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
