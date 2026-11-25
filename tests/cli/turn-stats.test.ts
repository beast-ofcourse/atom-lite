import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTokensPerSecond,
  formatTurnStats,
} from "../../dist/cli/turn-stats.js";

test("turn stats format the measured duration and generation speed", () => {
  assert.equal(formatTurnStats(454_000, 1000, 18_000), "7m 34s · 56 tok/s");
});

test("turn stats keep sub-second durations honest", () => {
  assert.equal(formatTurnStats(420, 240, 420), "0.4s · 571 tok/s");
  assert.equal(formatTurnStats(0, 240, 420), "0s · 571 tok/s");
});

test("turn stats omit a rate when the provider reported no usage", () => {
  assert.equal(formatTurnStats(4_200, 0, 0), "4s");
  assert.equal(formatTurnStats(4_200, 120, 0), "4s");
});

test("turn stats include model calls, prompt tokens, and cache share", () => {
  assert.equal(
    formatTurnStats(1_200, 100, 500, {
      modelCalls: 2,
      promptTokens: 12_400,
      cacheHitRate: 91,
    }),
    "1s · 200 tok/s · 2 calls · 12.4k prompt · 91% cached",
  );
  assert.equal(
    formatTurnStats(420, 240, 420, { modelCalls: 1 }),
    "0.4s · 571 tok/s · 1 call",
  );
  assert.equal(
    formatTurnStats(420, 240, 420, { modelCalls: 1, promptTokens: 900 }),
    "0.4s · 571 tok/s · 1 call · 900 prompt",
  );
});

test("tokens per second uses model time, not wall time", () => {
  // 500 output tokens over 10s of model time is 50 tok/s even if the turn
  // spent a minute waiting on tools.
  assert.equal(formatTokensPerSecond(500, 10_000), "50 tok/s");
  assert.equal(formatTokensPerSecond(0, 10_000), undefined);
  assert.equal(formatTokensPerSecond(500, 0), undefined);
});
