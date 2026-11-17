// Contract: compaction feeds goal, ledger, and active files to the summarizer,
// injects one continuation instruction, honors the compaction model, and
// bounds noisy tool output without dropping the retention set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextManager,
  renderContinuation,
} from "../../dist/context/manager.js";

function harness(overrides: Record<string, unknown> = {}) {
  const requests: any[] = [];
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const manager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: {
      generate: async (request: any) => {
        requests.push(request);
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "summary" }],
          },
          toolCalls: [],
          finishReason: "stop",
        };
      },
    } as any,
    model: "active-model",
    userInstructionsPath: join(dir, "missing-AGENTS.md"),
    ...overrides,
  });
  return { manager, requests, dir };
}

function history(): any[] {
  return Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${i}` }],
  }));
}

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => String(part?.text ?? "")).join("");
  }
  return String(content ?? "");
}

test("static context appears in the final build and the summarizer input", async () => {
  const { manager, requests } = harness();
  manager.setStaticContext({
    goal: "## Current goal\nStatement: Ship it\nSuccess criteria:\n- tests pass",
    ledger: "## Task ledger\n- [pending] T1: write code",
  });
  manager.setForceCompact(true);
  const messages = await manager.build("/tmp/ws", history());
  assert.ok(messages.some((m: any) => String(m.content).includes("Ship it")));
  assert.ok(
    messages.some((m: any) => String(m.content).includes("write code")),
  );
  const prompt = JSON.stringify(requests[0].messages);
  assert.match(prompt, /Ship it/);
  assert.match(prompt, /tests pass/);
  assert.match(prompt, /write code/);
});

test("exactly one continuation follows compaction and names todo and next action", async () => {
  const { manager } = harness();
  const continuation = {
    statement: "Ship it",
    criteria: ["tests pass", "docs updated"],
    currentTodo: "write code",
    nextAction: "Work on todo T1: write code",
  };
  manager.setStaticContext({
    goal: "## Current goal\nStatement: Ship it",
    ledger: "## Task ledger\n- [pending] T1: write code",
    continuation,
  });
  manager.setForceCompact(true);
  const messages = await manager.build("/tmp/ws", history());
  const continuationMessages = messages.filter((m: any) =>
    textOf(m).startsWith("Continuation after compaction:"),
  );
  assert.equal(continuationMessages.length, 1);
  const rendered = renderContinuation(continuation);
  assert.match(textOf(continuationMessages[0]), /Goal: Ship it/);
  assert.match(textOf(continuationMessages[0]), /tests pass; docs updated/);
  assert.match(textOf(continuationMessages[0]), /Current todo: write code/);
  assert.match(textOf(continuationMessages[0]), /Work on todo T1: write code/);
  assert.equal(manager.consumeCompactionContinuation(), rendered);
  assert.equal(manager.consumeCompactionContinuation(), null);
});

test("no continuation is injected when no goal or ledger exists", async () => {
  const { manager } = harness();
  manager.setForceCompact(true);
  const messages = await manager.build("/tmp/ws", history());
  assert.equal(
    messages.filter((m: any) =>
      textOf(m).startsWith("Continuation after compaction:"),
    ).length,
    0,
  );
});

test("compaction uses the active model by default and the configured model when set", async () => {
  const active = harness();
  active.manager.setForceCompact(true);
  await active.manager.build("/tmp/ws", history());
  assert.equal(active.requests[0].model, "active-model");

  const configured = harness({ compactionModel: "cheap-model" });
  configured.manager.setForceCompact(true);
  await configured.manager.build("/tmp/ws", history());
  assert.equal(configured.requests[0].model, "cheap-model");
});

test("bulky tool output is bounded and duplicate reads are dropped", async () => {
  const { manager, requests } = harness();
  const shared = "file contents ".repeat(400);
  const messages: any[] = [
    { role: "tool", name: "read", content: shared },
    { role: "tool", name: "read", content: shared },
    { role: "tool", name: "bash", content: "x".repeat(12000) },
    ...history(),
  ];
  manager.setForceCompact(true);
  await manager.build("/tmp/ws", messages);
  const serialized = JSON.stringify(requests[0].messages);
  assert.equal(serialized.split("duplicate file read omitted").length - 1, 1);
  assert.match(serialized, /\.\.\.\[truncated\]/);
  // One bounded read copy remains; the other is replaced by the marker.
  assert.ok(serialized.split("file contents").length - 1 < 400);
  assert.ok(serialized.length < 30_000);
});

test("active file paths remain in the compacted context and summarizer input", async () => {
  const { manager, requests } = harness();
  manager.setStaticContext({
    goal: "## Current goal\nStatement: Ship it",
    ledger: "## Task ledger\n- [pending] T1: write code",
    files: "- src/agent/loop.ts\n- src/runtime/goal.ts",
  });
  manager.setForceCompact(true);
  const messages = await manager.build("/tmp/ws", history());
  const joined = messages.map(textOf).join("\n");
  assert.match(joined, /Active files:/);
  assert.match(joined, /src\/agent\/loop\.ts/);
  assert.match(JSON.stringify(requests[0].messages), /src\/agent\/loop\.ts/);
});

test("goal and ledger remain in the compacted context", async () => {
  const { manager } = harness();
  manager.setStaticContext({
    goal: "## Current goal\nStatement: Ship it\nSuccess criteria:\n- tests pass",
    ledger: "## Task ledger\n- [pending] T1: write code",
  });
  manager.setForceCompact(true);
  const messages = await manager.build("/tmp/ws", history());
  const joined = messages.map((m) => textOf(m)).join("\n");
  assert.match(joined, /Ship it/);
  assert.match(joined, /tests pass/);
  assert.match(joined, /write code/);
  assert.match(joined, /Context summary:/);
});
