import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeUsageCost, FileUsageLedger } from "../../dist/usage/ledger.js";
import { recordModelUsage } from "../../dist/usage/ledger.js";
import { ConfigSchema } from "../../dist/config/schema.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

test("usage cost uses configured per-million rates and prices cache reads at input rate for the counterfactual", () => {
  const cost = computeUsageCost(
    { input: 10, output: 20, cacheRead: 2 },
    { input: 100, output: 50, total: 1150, cacheRead: 1000 },
  );
  assert.ok(cost);
  assert.ok(Math.abs(cost.costUsd - 0.004) < 1e-9);
  assert.ok(Math.abs(cost.costIfNoCacheUsd - 0.012) < 1e-9);
});

test("usage cost is absent without pricing or with an empty price object", () => {
  assert.equal(
    computeUsageCost(undefined, { input: 10, output: 2, total: 12 }),
    undefined,
  );
  assert.equal(
    computeUsageCost({}, { input: 10, output: 2, total: 12 }),
    undefined,
  );
});

test("pricing validates under the strict config schema and defaults to none", () => {
  const cfg = ConfigSchema.parse({
    usage: {
      prices: { "model-x": { input: 3, output: 6, cacheRead: 1 } },
    },
  });
  assert.equal((cfg.usage.prices as any)["model-x"].output, 6);
  assert.deepEqual(ConfigSchema.parse({}).usage.prices, {});
});

test("ledger writes monetary fields only for models with configured prices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-cost-"));
  const path = join(dir, "ledger.jsonl");
  const priced = new FileUsageLedger(path, {
    "model-x": { input: 10, output: 20, cacheRead: 2 },
  });
  recordModelUsage(
    priced,
    {
      sessionId: "s",
      requestId: "r",
      provider: "p",
      model: "model-x",
    },
    { input: 100, output: 50, total: 1150, cacheRead: 1000 },
  );
  recordModelUsage(
    priced,
    {
      sessionId: "s",
      requestId: "r2",
      provider: "p",
      model: "model-y",
    },
    { input: 100, output: 50, total: 150, cacheRead: 1000 },
  );

  const [withPrice, withoutPrice] = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(Math.abs(withPrice.costUsd - 0.004) < 1e-9);
  assert.ok(Math.abs(withPrice.costIfNoCacheUsd - 0.012) < 1e-9);
  assert.equal("costUsd" in withoutPrice, false);
  assert.equal("costIfNoCacheUsd" in withoutPrice, false);
});

test("an enabled ledger with pricing records cost for real model calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-cost-rt-"));
  const path = join(dir, "ledger.jsonl");
  const provider = new FakeProvider([
    {
      text: "ok",
      usage: { input: 200, output: 10, total: 210, cacheRead: 150 },
    },
  ]);
  const runtime = new AgentRuntime({
    provider,
    model: "model-x",
    workspace: dir,
    tools: [],
    usageLedger: new FileUsageLedger(path, {
      "model-x": { input: 10, output: 20, cacheRead: 1 },
    }),
  });
  await runtime.runAgentTurn(
    "hi",
    new InMemorySession("sess-cost", dir),
    new AbortController().signal,
  );

  const record = JSON.parse(readFileSync(path, "utf8").trim());
  assert.ok(typeof record.costUsd === "number");
  assert.ok(typeof record.costIfNoCacheUsd === "number");
  assert.ok(record.costIfNoCacheUsd > record.costUsd);
});
