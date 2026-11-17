import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileUsageLedger } from "../../dist/usage/ledger.js";

function sample(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    requestId: "req-1",
    provider: "fake",
    model: "model-x",
    usage: { input: 10, output: 2, total: 12 },
    ...overrides,
  };
}

test("usage ledger appends one JSON record per call and creates its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  const path = join(dir, "nested", "ledger.jsonl");
  const ledger = new FileUsageLedger(path);

  ledger.record(sample({ requestId: "req-1" }));
  ledger.record(sample({ requestId: "req-2" }));

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.requestId, "req-1");
  assert.equal(first.sessionId, "sess-1");
  assert.equal(first.provider, "fake");
  assert.equal(first.model, "model-x");
  assert.deepEqual(first.usage, { input: 10, output: 2, total: 12 });
  assert.equal(JSON.parse(lines[1]).requestId, "req-2");
});

test("usage ledger records carry identifiers and counts only, never message text", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  const path = join(dir, "ledger.jsonl");
  const ledger = new FileUsageLedger(path);

  ledger.record(sample());

  const parsed = JSON.parse(readFileSync(path, "utf8").trim());
  assert.deepEqual(Object.keys(parsed).sort(), [
    "model",
    "provider",
    "requestId",
    "sessionId",
    "timestamp",
    "usage",
  ]);
  assert.deepEqual(Object.keys(parsed.usage).sort(), [
    "input",
    "output",
    "total",
  ]);
});

test("usage ledger write failures never propagate to the caller", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  const path = join(dir, "a-directory");
  mkdirSync(path);

  const ledger = new FileUsageLedger(path);
  assert.doesNotThrow(() => ledger.record(sample()));
});
