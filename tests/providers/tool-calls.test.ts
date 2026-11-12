// Streaming tool-call assembly shared by all adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleToolCalls,
  parseArgs,
  toToolCalls,
  type RawToolCallChunk,
} from "../../dist/providers/tool-calls.js";

test("assembles a single call from streamed argument fragments", () => {
  const batches: RawToolCallChunk[][] = [
    [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }],
    [{ index: 0, function: { arguments: 'th": "a.txt"}' } }],
  ];
  const out = assembleToolCalls(batches);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "c1");
  assert.equal(out[0].name, "read");
  assert.deepEqual(out[0].arguments, { path: "a.txt" });
});

test("parallel calls are keyed by index", () => {
  const batches: RawToolCallChunk[][] = [
    [
      { index: 0, id: "a", function: { name: "read", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "write", arguments: "{}" } },
    ],
  ];
  const out = assembleToolCalls(batches);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "read");
  assert.equal(out[1].name, "write");
});

test("a batch without indexes appends sequentially", () => {
  const out = assembleToolCalls([
    [{ function: { name: "one", arguments: "{}" } }],
    [{ function: { name: "two", arguments: "{}" } }],
  ]);
  assert.deepEqual(
    out.map((c) => c.name),
    ["one", "two"],
  );
});

test("missing name defaults to empty and missing args to {}", () => {
  const out = assembleToolCalls([[{ index: 0 }]]);
  assert.equal(out[0].name, "");
  assert.deepEqual(out[0].arguments, {});
});

test("parseArgs rejects non-object payloads and malformed JSON", () => {
  assert.throws(() => parseArgs("[1,2]"), /PROVIDER_INVALID_RESPONSE/);
  assert.throws(() => parseArgs("{oops"), /PROVIDER_INVALID_RESPONSE/);
  assert.deepEqual(parseArgs(""), {});
});

test("toToolCalls shapes provider-agnostic ToolCall objects", () => {
  const calls = toToolCalls([
    {
      id: "c1",
      name: "bash",
      arguments: { command: "ls" },
      rawArguments: '{"command":"ls"}',
    },
  ]);
  assert.deepEqual(calls, [
    { id: "c1", name: "bash", arguments: { command: "ls" } },
  ]);
});
