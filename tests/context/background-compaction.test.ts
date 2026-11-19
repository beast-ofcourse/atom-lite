// Contract: background preparation writes a summary before the trigger and
// compaction swaps it in without a second summarizer call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

function messages(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${i} ${"x".repeat(180)}` }],
  }));
}

test("a held summary is prepared ahead of the trigger and swapped in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-bg-"));
  const requests: any[] = [];
  const cm = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: 10_000,
    reserveOutputTokens: 1000,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    background: true,
    provider: {
      id: "test",
      generate: async (request: any) => {
        requests.push(request);
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: VALID_SUMMARY }],
          },
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 10, output: 5 },
        };
      },
    } as any,
    model: "test-model",
    userInstructionsPath: join(dir, "missing-AGENTS.md"),
  });

  const history = messages(80);
  await cm.build(dir, history);
  await cm.awaitBackground();
  assert.equal(requests.length, 1, "precompute should summarize once");

  cm.setForceCompact(true);
  const compacted = await cm.build(dir, history);
  assert.equal(requests.length, 1, "compaction should reuse the held summary");
  assert.equal(cm.consumeCompaction(), true);
  const checkpoint = cm.getLastCompactionCheckpoint();
  assert.equal(checkpoint?.summary, VALID_SUMMARY);
  assert.ok((compacted as any[]).some((m) =>
    JSON.stringify(m).includes("Context summary:"),
  ));
});
