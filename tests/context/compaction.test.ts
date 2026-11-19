// Contract: compaction produces a validated memory checkpoint, retries once
// with a nudge when headings are missing, records versioned checkpoint data,
// and keeps the tail user-aligned and token-bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

function manager(dir: string, responses: any[]): any {
  const requests: any[] = [];
  const cm = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: {
      id: "test-provider",
      generate: async (req: any) => {
        requests.push(req);
        const text = responses.shift() ?? VALID_SUMMARY;
        if (typeof text === "string" && text.startsWith("THROW:")) {
          throw new Error(text.slice(6));
        }
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 100, output: 20 },
        };
      },
    } as any,
    model: "test-model",
    userInstructionsPath: join(dir, "user-AGENTS.md"),
  });
  return { cm, requests };
}

function history(): any[] {
  return Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
}

test("compaction prompt retains open tasks and verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const { cm, requests } = manager(dir, []);
  cm.setForceCompact(true);
  await cm.build(dir, history());
  assert.ok(requests.length > 0);
  const prompt = JSON.stringify(requests[0].messages);
  assert.match(prompt, /every user-assigned task/);
  assert.match(prompt, /Never drop an open task/);
});

test("a malformed summary gets exactly one corrective prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const { cm, requests } = manager(dir, [
    "## Objective\nonly one",
    VALID_SUMMARY,
  ]);
  cm.setForceCompact(true);
  await cm.build(dir, history());
  assert.equal(requests.length, 2);
  assert.match(
    JSON.stringify(requests[1].messages),
    /nudge|required headings/i,
  );
  assert.equal(cm.consumeCompactionFailure(), null);
  assert.match(cm.getSessionMemory() ?? "", /## Objective/);
});

test("a second malformed summary keeps prior memory and reports failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const { cm } = manager(dir, ["bad", "still bad"]);
  cm.setSessionMemory("## Objective\nkeep me", 3);
  cm.setForceCompact(true);
  await cm.build(dir, history());
  assert.match(cm.consumeCompactionFailure() ?? "", /heading/i);
  assert.equal(cm.getSessionMemory(), "## Objective\nkeep me");
});

test("a completed compaction exposes a versioned checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const { cm } = manager(dir, []);
  cm.setForceCompact(true);
  await cm.build(dir, history());
  const checkpoint = cm.getLastCompactionCheckpoint();
  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.summary, VALID_SUMMARY);
  assert.equal(checkpoint.strategy, "summary");
  assert.ok(checkpoint.coveredCount > 0);
  assert.ok(checkpoint.keptCount > 0);
  assert.equal(checkpoint.model, "test-model");
  assert.equal(checkpoint.usage.input, 100);
});

test("an oversized summary request is retried with a smaller request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const { cm, requests } = manager(dir, [
    "THROW:context length exceeded",
    VALID_SUMMARY,
  ]);
  cm.setForceCompact(true);
  await cm.build(dir, history());
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /\[truncated\]/);
});
