import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";

function manager(dir: string, requests: any[]): any {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 10,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: {
      generate: async (req: any) => {
        requests.push(req);
        return {
          message: { role: "assistant", content: [{ type: "text", text: "summary" }] },
          toolCalls: [],
          finishReason: "stop",
        };
      },
    } as any,
    model: "test",
    userInstructionsPath: join(dir, "user-AGENTS.md"),
  });
}

test("compaction prompt retains open tasks and verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const requests: any[] = [];
  const cm = manager(dir, requests);
  cm.setForceCompact(true);
  const history = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
  await cm.build(dir, history as any);
  assert.ok(requests.length > 0);
  const prompt = JSON.stringify(requests[0].messages);
  assert.match(prompt, /every user-assigned task/);
  assert.match(prompt, /Never drop an open task/);
});
