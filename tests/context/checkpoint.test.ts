// Contract: memory-checkpoint helpers keep the tail token-bounded and
// user-aligned, generate a structured summary prompt, and resolve the
// compaction reserve from compactAtPercent or an explicit override.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSummaryPrompt,
  hasAllSummaryHeadings,
  resolveReserve,
  splitRecentTail,
  SUMMARY_HEADINGS,
} from "../../dist/context/checkpoint.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

function message(role: "user" | "assistant", size = 400): any {
  return {
    role,
    content: [{ type: "text", text: "x".repeat(size) }],
  };
}

test("summary prompt requests every heading and switches to update mode", () => {
  const initial = buildSummaryPrompt({});
  for (const heading of SUMMARY_HEADINGS) {
    assert.ok(initial.includes(heading), `missing ${heading}`);
  }
  const update = buildSummaryPrompt({ previous: "## Objective\nold" });
  assert.match(update, /Update the existing checkpoint/);
  assert.match(update, /## Objective\nold/);
});

test("heading validation requires the full set", () => {
  assert.equal(hasAllSummaryHeadings(VALID_SUMMARY), true);
  assert.equal(hasAllSummaryHeadings("## Objective\nonly one"), false);
  assert.equal(hasAllSummaryHeadings(""), false);
});

test("recent tail stays within the keep budget and starts on a user message", () => {
  const history = [
    message("user"),
    message("assistant"),
    message("user"),
    message("assistant"),
    message("user"),
    message("assistant"),
  ];
  const split = splitRecentTail(history, 250, 100_000);
  assert.equal(split.recent.length + split.older.length, history.length);
  assert.equal(split.recent[0]?.role, "user");
  assert.ok(split.keptTokens <= 250);
  assert.equal(split.keptCount, split.recent.length);
});

test("recent tail also respects the small-window safety ceiling", () => {
  const history = [message("user"), message("assistant"), message("user")];
  const split = splitRecentTail(history, 100_000, 200);
  assert.ok(split.keptTokens <= 200);
  assert.ok(split.older.length > 0);
});

test("reserve derives from compactAtPercent unless explicitly overridden", () => {
  assert.deepEqual(resolveReserve(85, undefined), {
    kind: "percent",
    value: 15,
  });
  assert.deepEqual(resolveReserve(85, "20%"), {
    kind: "percent",
    value: 20,
  });
  assert.deepEqual(resolveReserve(85, 10_000), {
    kind: "tokens",
    value: 10_000,
  });
});
