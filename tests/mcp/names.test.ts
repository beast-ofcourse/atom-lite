import { test } from "node:test";
import assert from "node:assert/strict";
import {
  namespacedToolName,
  sanitizeNameSegment,
} from "../../dist/mcp/manager.js";

test("sanitizeNameSegment replaces invalid chars", () => {
  assert.equal(sanitizeNameSegment("a b/c"), "a_b_c");
  assert.equal(sanitizeNameSegment(""), "tool");
});

test("namespacedToolName caps length", () => {
  const longTool = "x".repeat(100);
  const name = namespacedToolName("srv", longTool);
  assert.ok(name.length <= 64);
  assert.match(name, /^mcp__srv__/);
});
