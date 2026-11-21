import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getUsageBreakdown,
  type UsageRecord,
} from "../../dist/usage/ledger.js";

const rec = (
  provider: string,
  model: string,
  cost: number,
  tokens: number,
  kind?: any,
): UsageRecord => ({
  timestamp: "",
  sessionId: "s",
  requestId: "r",
  provider,
  model,
  ...(kind ? { kind } : {}),
  costUsd: cost,
  usage: { input: tokens, output: 0 },
});

test("groups by responding model and sorts by cost", () => {
  const out = getUsageBreakdown([
    rec("openai", "gpt-4o", 0.1, 100),
    rec("anthropic", "claude", 0.5, 200),
    rec("openai", "gpt-4o", 0.2, 100),
  ]);
  assert.deepEqual(
    out.map((e) => e.key),
    ["anthropic/claude", "openai/gpt-4o"],
  );
  assert.equal(Number(out[1].cost.toFixed(3)), 0.3);
  assert.equal(out[1].tokens, 200);
});

test("tool and summary records go to a separate bucket", () => {
  const out = getUsageBreakdown([
    rec("openai", "gpt-4o", 0.1, 100),
    rec("system", "summary", 0.05, 50, "summary"),
  ]);
  assert.deepEqual(
    out.map((e) => e.key),
    ["openai/gpt-4o", "Tools/summaries"],
  );
});

test("zero entries are dropped", () => {
  const out = getUsageBreakdown([rec("openai", "empty", 0, 0)]);
  assert.equal(out.length, 0);
});
