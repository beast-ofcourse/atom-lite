import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { ConfigSchema } from "../../dist/config/schema.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import type { Message } from "../../dist/types.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";

const summaryText = (label: string) =>
  SUMMARY_HEADINGS.map(
    (heading, index) => `${heading}\n- ${index === 0 ? label : "value"}`,
  ).join("\n\n");

function manager(mode: "off" | "automatic" | "explicit", workspace: string) {
  return new ContextManager({
    systemPrompt: "STABLE SYSTEM PROMPT",
    maxInputTokens: null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: new FakeProvider([]),
    model: "m",
    cacheMode: mode,
    userInstructionsPath: join(workspace, "AGENTS.md"),
  });
}

function serialize(messages: Message[]): string {
  return JSON.stringify(messages);
}

test("automatic mode keeps the stable prefix identical while volatile context changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cachemode-"));
  const cm = manager("automatic", dir);
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "question one" }] },
    { role: "assistant", content: [{ type: "text", text: "answer one" }] },
  ];

  cm.setStaticContext({
    goal: "GOAL VERSION ONE",
    ledger: "TASK ONE",
    files: "FILE A",
  });
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUCTIONS VERSION ONE");
  cm.invalidateCaches();
  const first = await cm.build(dir, history);

  cm.setStaticContext({
    goal: "A COMPLETELY DIFFERENT GOAL",
    ledger: "TASK TWO",
    files: "FILE B",
  });
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUCTIONS VERSION TWO");
  cm.invalidateCaches();
  const second = await cm.build(dir, history);

  const volatileCount = 4; // goal, ledger, active files, project instruction
  const prefix = (messages: Message[]) =>
    serialize(messages.slice(0, messages.length - volatileCount));
  assert.equal(prefix(first), prefix(second));
  assert.ok(serialize(first).includes("GOAL VERSION ONE"));
  assert.ok(serialize(second).includes("A COMPLETELY DIFFERENT GOAL"));
});

test("off mode preserves the original message order and automatic mode only relocates volatile messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cachemode-off-"));
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUCTIONS");
  const off = await manager("off", dir).build(dir, [
    { role: "user", content: [{ type: "text", text: "q" }] },
  ]);
  const automatic = await manager("automatic", dir).build(dir, [
    { role: "user", content: [{ type: "text", text: "q" }] },
  ]);

  assert.deepEqual(
    off.map((m) => m.role),
    ["system", "system", "user"],
  );
  assert.deepEqual(
    [...automatic].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    [...off].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  const serialized = serialize(automatic);
  assert.ok(!serialized.includes("cache_control"));
  assert.ok(!serialized.includes("prompt_cache_breakpoint"));
});

test("automatic mode keeps the prefix stable after compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cachemode-compact-"));
  const cm = new ContextManager({
    systemPrompt: "STABLE SYSTEM PROMPT",
    maxInputTokens: null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: new FakeProvider([
      { text: summaryText("SUMMARY ONE") },
      { text: summaryText("SUMMARY TWO") },
    ]),
    model: "m",
    cacheMode: "automatic",
    userInstructionsPath: join(dir, "AGENTS.md"),
  });
  writeFileSync(join(dir, "AGENTS.md"), "INSTRUCTIONS");
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "old one" }] },
    { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: [{ type: "text", text: "old two" }] },
  ];

  cm.setStaticContext({ goal: "GOAL A", ledger: null, files: null });
  cm.setForceCompact(true);
  const compacted = await cm.build(dir, history);

  cm.setStaticContext({ goal: "GOAL A", ledger: null, files: null });
  const settled = await cm.build(dir, history);
  cm.setStaticContext({ goal: "GOAL B", ledger: null, files: null });
  const changed = await cm.build(dir, history);

  const volatileCount = 2; // goal + project instruction
  const prefix = (messages: Message[]) =>
    serialize(messages.slice(0, messages.length - volatileCount));
  assert.match(serialize(compacted), /Context summary:/);
  assert.ok(serialize(compacted).includes("SUMMARY ONE"));
  assert.equal(prefix(settled), prefix(changed));
  assert.ok(serialize(settled).includes("GOAL A"));
  assert.ok(serialize(changed).includes("GOAL B"));
});

test("ledger records report stable prefix size/hash and flag prefix drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cachemode-ledger-"));
  const cm = manager("automatic", dir);
  const records: any[] = [];
  const runtime = new AgentRuntime({
    provider: new FakeProvider([
      { text: "one", usage: { input: 10, output: 1, total: 11 } },
      { text: "two", usage: { input: 10, output: 1, total: 11 } },
      { text: "three", usage: { input: 10, output: 1, total: 11 } },
    ]),
    workspace: dir,
    tools: [],
    contextManager: cm,
    cacheMode: "automatic",
    usageLedger: { record: (r: any) => records.push(r) },
  });
  const session = new InMemorySession("sess-prefix", dir);

  cm.setStaticContext({ goal: "GOAL ONE", ledger: null, files: null });
  await runtime.runAgentTurn("q1", session, new AbortController().signal);
  cm.setStaticContext({ goal: "GOAL TWO", ledger: null, files: null });
  await runtime.runAgentTurn("q2", session, new AbortController().signal);
  assert.ok(records[0].prefix?.bytes > 0);
  assert.match(records[0].prefix.hash, /^[0-9a-f]{64}$/);
  assert.equal(records[0].prefix.changed, false);
  assert.equal(records[1].prefix.changed, false);

  cm.setSystemPrompt("A DIFFERENT STABLE SYSTEM PROMPT");
  await runtime.runAgentTurn("q3", session, new AbortController().signal);
  assert.equal(records[2].prefix.changed, true);
});

test("caching mode validates under the strict config schema and defaults to off", () => {
  assert.equal(ConfigSchema.parse({}).context.cacheMode, "off");
  assert.equal(
    ConfigSchema.parse({ context: { cacheMode: "automatic" } }).context
      .cacheMode,
    "automatic",
  );
  assert.equal(
    ConfigSchema.parse({ context: { cacheMode: "explicit" } }).context
      .cacheMode,
    "explicit",
  );
  assert.throws(() => ConfigSchema.parse({ context: { cacheMode: "bogus" } }));
});
