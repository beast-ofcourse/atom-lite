// Context budget estimation: the heuristic behind compaction decisions.
// estimateMessageTokens measures the JSON-serialized message (~4 chars per
// token) with images stripped, so expectations below derive from that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateMessageTokens } from "../../dist/context/budget.js";
import type { Message } from "../../dist/types.js";

function jsonLen(message: unknown): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

test("system prompts estimate from their JSON length", () => {
  const m: Message = { role: "system", content: "x".repeat(40) };
  assert.equal(estimateMessageTokens(m), jsonLen(m));
  assert.ok(estimateMessageTokens(m) > 10);
});

test("user messages estimate from text parts only", () => {
  const m: Message = {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ],
  };
  assert.equal(estimateMessageTokens(m), jsonLen(m));
});

test("tool results estimate from their content", () => {
  const m: Message = {
    role: "tool",
    toolCallId: "1",
    name: "read",
    content: "z".repeat(80),
  };
  assert.equal(estimateMessageTokens(m), jsonLen(m));
});

test("image payloads are stripped before estimation", () => {
  // A 2KB base64 blob must not dominate the estimate.
  const m: Message = {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image", data: "A".repeat(2048), mime: "image/png" },
    ],
  };
  const withTextOnly: Message = {
    role: "user",
    content: [{ type: "text", text: "describe" }],
  };
  assert.equal(estimateMessageTokens(m), jsonLen(withTextOnly));
});

test("empty content costs little", () => {
  const m: Message = { role: "system", content: "" };
  assert.ok(estimateMessageTokens(m) < 10);
});

test("estimation grows monotonically with content size", () => {
  const small: Message = { role: "system", content: "x".repeat(10) };
  const big: Message = { role: "system", content: "x".repeat(10_000) };
  assert.ok(estimateMessageTokens(big) > estimateMessageTokens(small) * 10);
});

test("repeated estimation of the same object is memoized and consistent", () => {
  const m: Message = {
    role: "user",
    content: [{ type: "text", text: "abc".repeat(100) }],
  };
  const a = estimateMessageTokens(m);
  const b = estimateMessageTokens(m);
  assert.equal(a, b);
  assert.ok(a > 0);
});
