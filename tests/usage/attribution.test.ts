import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeMessages,
  rememberMessageLayout,
} from "../../dist/context/attribution.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { ContextManager } from "../../dist/context/manager.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { GoalStore } from "../../dist/runtime/goal.js";
import { estimateMessageTokens } from "../../dist/context/budget.js";
import type { Message } from "../../dist/types.js";

const system = (content: string): Message => ({ role: "system", content });
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

test("remembered layout attributes each message to the right component", () => {
  const messages: Message[] = [
    system("BASE SYSTEM PROMPT WITH SKILL INDEX"),
    system("GOAL TEXT"),
    system("Active files:\nFILE A"),
    system("PROJECT INSTRUCTION ONE"),
    assistant("Context summary from previous compaction:\nSUMMARY TEXT"),
    user("HISTORY QUESTION"),
  ];
  rememberMessageLayout(messages, {
    systemPromptEnd: 1,
    staticMessagesEnd: 3,
    instructionsEnd: 4,
    sessionMemoryEnd: 5,
    historyEnd: messages.length,
    toolTokenOverhead: 42,
    compacted: false,
  });

  const { attribution, compacted } = attributeMessages(messages);
  assert.equal(compacted, false);
  assert.equal(attribution.systemPrompt, estimateMessageTokens(messages[0]));
  assert.equal(
    attribution.staticMessages,
    estimateMessageTokens(messages[1]) + estimateMessageTokens(messages[2]),
  );
  assert.equal(attribution.projectInstructions, estimateMessageTokens(messages[3]));
  assert.equal(attribution.sessionMemory, estimateMessageTokens(messages[4]));
  assert.equal(attribution.history, estimateMessageTokens(messages[5]));
  assert.equal(attribution.toolDefinitions, 42);
});

test("layout is ignored when the final message list was replaced or resized", () => {
  const messages: Message[] = [system("system"), user("one")];
  rememberMessageLayout(messages, {
    systemPromptEnd: 1,
    staticMessagesEnd: 1,
    instructionsEnd: 1,
    sessionMemoryEnd: 1,
    historyEnd: messages.length,
    toolTokenOverhead: 7,
    compacted: false,
  });
  messages.push(user("two"));

  const { attribution } = attributeMessages(messages);
  assert.equal(attribution.history, estimateMessageTokens(messages[1]) + estimateMessageTokens(messages[2]));
});

test("a real turn records attribution and reflects extension mutations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attrib-"));
  const provider = new FakeProvider([
    { text: "answer", usage: { input: 20, output: 4, total: 24 } },
  ]);
  const records: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    model: "m",
    workspace: dir,
    tools: [],
    usageLedger: { record: (r: any) => records.push(r) },
    extensionDispatch: (event: string, payload: any) => {
      if (event === "context_build") {
        payload.messages.push(user("INJECTED BY EXTENSION"));
      }
      return [];
    },
  } as any);
  const session = new InMemorySession("sess-attrib", dir);
  await runtime.runAgentTurn(
    "question",
    session,
    new AbortController().signal,
    { requestId: "req-attrib" },
  );

  assert.equal(records.length, 1);
  const attribution = records[0].attribution;
  assert.ok(attribution, "record has a token attribution breakdown");
  for (const key of [
    "systemPrompt",
    "staticMessages",
    "projectInstructions",
    "sessionMemory",
    "history",
    "toolDefinitions",
  ]) {
    assert.equal(typeof attribution[key], "number", `${key} is numeric`);
  }
  assert.equal(typeof records[0].compacted, "boolean");
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("INJECTED BY EXTENSION"));
  assert.ok(!serialized.includes("question"));
});

test("multi-turn attribution tracks changing static context and tool definitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attrib-multi-"));
  const provider = new FakeProvider([
    { text: "one", usage: { input: 10, output: 1, total: 11 } },
    { text: "two", usage: { input: 20, output: 1, total: 21 } },
  ]);
  const smallTool = {
    definition: { name: "a", description: "small", parameters: {} },
    execute: async () => ({ toolCallId: "x", name: "a", content: "ok" }),
  };
  const bigTool = {
    definition: {
      name: "b",
      description: "A much longer description ".repeat(20),
      parameters: { a: { type: "string" } },
    },
    execute: async () => ({ toolCallId: "x", name: "b", content: "ok" }),
  };
  const records: any[] = [];
  const goalStore = new GoalStore();
  const contextManager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider,
    model: "m",
  });
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [smallTool],
    contextManager,
    goalStore,
    usageLedger: { record: (r: any) => records.push(r) },
  });
  const session = new InMemorySession("sess-multi", dir);

  await runtime.runAgentTurn("first", session, new AbortController().signal);
  goalStore.set("EXPANDED GOAL ".repeat(20));
  runtime.setTools([bigTool]);
  await runtime.runAgentTurn("second", session, new AbortController().signal);

  assert.equal(records.length, 2);
  assert.ok(
    records[1].attribution.staticMessages > records[0].attribution.staticMessages,
  );
  assert.ok(
    records[1].attribution.toolDefinitions > records[0].attribution.toolDefinitions,
  );
});

test("resumed session memory is attributed to sessionMemory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attrib-resume-"));
  const provider = new FakeProvider([
    { text: "answer", usage: { input: 30, output: 2, total: 32 } },
  ]);
  const records: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    usageLedger: { record: (r: any) => records.push(r) },
  });
  const session = new InMemorySession("sess-resume", dir);
  session.events.push({
    type: "context_compacted",
    summary: "PERSISTED SUMMARY TEXT",
    coveredCount: 2,
  } as any);
  session.messages.push(user("old"));
  session.messages.push(assistant("older"));

  await runtime.runAgentTurn(
    "question",
    session,
    new AbortController().signal,
  );

  assert.ok(records[0].attribution.sessionMemory > 0);
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("PERSISTED SUMMARY TEXT"));
});
