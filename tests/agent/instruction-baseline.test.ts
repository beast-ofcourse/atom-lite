// Contract: the runtime freezes instruction text in a session event, records
// later changes, and folds the current text into a new baseline at compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { ContextManager } from "../../dist/context/manager.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";
import type { Message, ModelRequest } from "../../dist/types.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

class Session {
  messages: Message[] = [];
  events: any[] = [];
  appendMessage(message: Message): void {
    this.messages.push(message);
  }
  appendEvent(partial: any): any {
    const event = { timestamp: new Date().toISOString(), ...partial };
    this.events.push(event);
    return event;
  }
}

class Provider {
  requests: ModelRequest[] = [];
  private responses: string[];
  constructor(responses: string[] = []) {
    this.responses = responses;
  }
  get id(): string {
    return "test";
  }
  async generate(request: ModelRequest): Promise<any> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: this.responses.shift() ?? "done" }],
      },
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

function runtime(
  dir: string,
  provider: Provider,
  contextManager: ContextManager,
) {
  return new AgentRuntime({
    provider: provider as any,
    workspace: dir,
    tools: [],
    contextManager,
  });
}

function manager(dir: string, provider: Provider): ContextManager {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: provider as any,
    model: "test",
    userInstructionsPath: join(dir, "missing-user-AGENTS.md"),
  });
}

function textOf(messages: Message[]): string {
  return JSON.stringify(messages);
}

test("first turn freezes instruction text into a versioned session event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-ibl-"));
  writeFileSync(join(dir, "AGENTS.md"), "frozen rule");
  const provider = new Provider();
  const session = new Session();
  await runtime(dir, provider, manager(dir, provider)).runAgentTurn(
    "hello",
    session as any,
    new AbortController().signal,
  );
  const baselines = session.events.filter(
    (e) => e.type === "instruction_baseline",
  );
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].schemaVersion, 1);
  assert.deepEqual(baselines[0].baseline, ["frozen rule"]);
  assert.deepEqual(baselines[0].updates, []);
});

test("compaction folds current instruction text into a new baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-ibl-fold-"));
  writeFileSync(join(dir, "AGENTS.md"), "rule one");
  const provider = new Provider([VALID_SUMMARY, "done"]);
  const cm = manager(dir, provider);
  cm.setForceCompact(true);
  const session = new Session();
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "old" }],
  });
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  });
  await runtime(dir, provider, cm).runAgentTurn(
    "continue",
    session as any,
    new AbortController().signal,
  );
  const baselines = session.events.filter(
    (e) => e.type === "instruction_baseline",
  );
  assert.equal(baselines.length, 2);
  const folded = baselines[1];
  assert.deepEqual(folded.baseline, ["rule one"]);
  assert.deepEqual(folded.updates, []);
  assert.ok(folded.baselineSeq > baselines[0].baselineSeq);
  const summarizer = JSON.stringify(provider.requests[0].messages);
  assert.match(summarizer, /rule one/);
});

test("resumed session keeps frozen baseline text after the file changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-ibl-resume-"));
  writeFileSync(join(dir, "AGENTS.md"), "old rule");
  const firstProvider = new Provider();
  const firstSession = new Session();
  await runtime(dir, firstProvider, manager(dir, firstProvider)).runAgentTurn(
    "hello",
    firstSession as any,
    new AbortController().signal,
  );

  writeFileSync(join(dir, "AGENTS.md"), "new rule");
  const secondProvider = new Provider();
  const second = manager(dir, secondProvider);
  await runtime(dir, secondProvider, second).runAgentTurn(
    "again",
    firstSession as any,
    new AbortController().signal,
  );
  const built = await second.build(dir, firstSession.messages);
  const joined = textOf(built);
  assert.ok(joined.includes("old rule"));
  assert.ok(joined.includes("new rule"));
});
