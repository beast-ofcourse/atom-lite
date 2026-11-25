// Contract: NDJSON child turns need per-call cache and cost fields. The usage
// event emitted with a completed assistant message must carry them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnRecorder } from "../../dist/agent/turn-recorder.js";

test("usage event carries cache counts and computed cost", async () => {
  const events: any[] = [];
  const recorder = new TurnRecorder({
    session: { appendMessage: () => {} },
    onEvent: (event) => events.push(event),
    prices: {
      "test-model": { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
    },
    model: "test-model",
  });

  await recorder.recordAssistant(
    {
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
    },
    "ok",
  );

  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 20);
  assert.equal(usage.cacheRead, 50);
  assert.equal(usage.cacheWrite, 10);
  assert.equal(usage.model, "test-model");
  assert.equal(usage.cost, (100 * 2 + 20 * 4 + 50 * 1 + 10 * 3) / 1_000_000);
});
