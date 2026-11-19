// Contract: provider-managed compaction stores an opaque checkpoint payload,
// keeps recent user messages, never falls back to summary on rejection, and
// replays the original conversation when the model changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";

function messages(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${i} ${"x".repeat(180)}` }],
  }));
}

function harness(compact: (request: any) => Promise<any>) {
  const requests: any[] = [];
  const generateCalls: any[] = [];
  const provider = {
    id: "native-provider",
    model: "model-a",
    compact,
    generate: async (request: any) => {
      generateCalls.push(request);
      requests.push(request);
      return {
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
  const cm = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    strategy: "native",
    provider: provider as any,
    model: "model-a",
    userInstructionsPath: "/tmp/missing-native-AGENTS.md",
  });
  return { cm, provider, generateCalls };
}

test("native compaction records the provider payload and keeps user messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-native-"));
  const calls: any[] = [];
  const { cm } = harness(async (request) => {
    calls.push(request);
    return { payload: "opaque-checkpoint" };
  });
  cm.setForceCompact(true);
  const built = await cm.build(dir, messages(10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "model-a");
  assert.ok(calls[0].keepTokens > 0);
  const checkpoint = cm.getLastCompactionCheckpoint();
  assert.equal(checkpoint?.strategy, "native");
  assert.equal(checkpoint?.native?.provider, "native-provider");
  assert.equal(checkpoint?.native?.model, "model-a");
  assert.equal(checkpoint?.native?.payload, "opaque-checkpoint");
  assert.match(JSON.stringify(built), /opaque-checkpoint/);
});

test("a native rejection is an error, not a downgrade to summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-native-reject-"));
  const { cm, generateCalls } = harness(async () => {
    throw new Error("native compaction rejected");
  });
  cm.setForceCompact(true);
  await cm.build(dir, messages(10));
  assert.match(cm.consumeCompactionFailure() ?? "", /native/i);
  assert.equal(cm.getSessionMemory(), null);
  assert.equal(generateCalls.length, 0);
});

test("a model switch replays the original conversation instead of the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-native-switch-"));
  const { cm } = harness(async () => ({ payload: "old-payload" }));
  cm.setSessionMemory("[provider checkpoint]", 8, {
    schemaVersion: 1,
    summary: "[provider checkpoint]",
    coveredCount: 8,
    coveredTokens: 400,
    keptCount: 2,
    model: "model-a",
    strategy: "native",
    native: {
      provider: "native-provider",
      model: "model-a",
      payload: "old-payload",
    },
  });
  cm.setProvider(
    {
      id: "native-provider",
      model: "model-b",
      generate: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        toolCalls: [],
        finishReason: "stop",
      }),
    } as any,
    "model-b",
  );
  const history = messages(10);
  const built = await cm.build(dir, history);
  assert.match(JSON.stringify(built), /message 0 /);
  assert.doesNotMatch(JSON.stringify(built), /old-payload/);
});

test("manual compaction records a native checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-native-manual-"));
  const { cm } = harness(async () => ({ payload: "manual-payload" }));
  const summary = await cm.compactHistory(dir, messages(10));
  assert.match(summary ?? "", /provider checkpoint/i);
  assert.equal(
    cm.getLastCompactionCheckpoint()?.native?.payload,
    "manual-payload",
  );
});
