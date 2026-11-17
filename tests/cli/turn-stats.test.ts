import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTokensPerSecond,
  formatTurnStats,
} from "../../dist/cli/turn-stats.js";

test("turn stats format the measured duration and generation speed", () => {
  assert.equal(formatTurnStats(454_000, 1000, 18_000), "7m 34s · 56 tok/s");
});

test("turn stats omit a rate when the provider reported no usage", () => {
  assert.equal(formatTurnStats(4_200, 0, 0), "4s");
  assert.equal(formatTurnStats(4_200, 120, 0), "4s");
});

test("tokens per second uses model time, not wall time", () => {
  // 500 output tokens over 10s of model time is 50 tok/s even if the turn
  // spent a minute waiting on tools.
  assert.equal(formatTokensPerSecond(500, 10_000), "50 tok/s");
  assert.equal(formatTokensPerSecond(0, 10_000), undefined);
  assert.equal(formatTokensPerSecond(500, 0), undefined);
});
