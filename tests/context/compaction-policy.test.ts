// Contract: compaction policy resolves model over provider over global, and
// only selects provider-managed compaction when the provider advertises it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCompactionPolicy } from "../../dist/context/compaction-policy.js";

test("auto selects summary when the provider has no native capability", () => {
  assert.equal(
    resolveCompactionPolicy({}, "model-a", false),
    "summary",
  );
});

test("auto selects native when the provider advertises it", () => {
  assert.equal(resolveCompactionPolicy({}, "model-a", true), "native");
});

test("explicit strategy overrides auto", () => {
  assert.equal(
    resolveCompactionPolicy({ global: "summary" }, "model-a", true),
    "summary",
  );
  assert.equal(
    resolveCompactionPolicy({ global: "native" }, "model-a", true),
    "native",
  );
});

test("provider policy overrides global and model policy overrides provider", () => {
  const config = {
    global: "summary" as const,
    provider: "native" as const,
    models: { "model-a": { compactionStrategy: "summary" as const } },
  };
  assert.equal(resolveCompactionPolicy(config, "model-a", true), "summary");
  assert.equal(resolveCompactionPolicy(config, "model-b", true), "native");
});

test("native without capability falls back to summary", () => {
  assert.equal(
    resolveCompactionPolicy({ provider: "native" }, "model-a", false),
    "summary",
  );
});
