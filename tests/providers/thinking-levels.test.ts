import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSupportedThinkingLevels,
  clampThinkingLevel,
} from "../../dist/providers/thinking-levels.js";

const reasoningModel = (map?: any) =>
  ({
    id: "m",
    reasoning: true,
    thinkingLevelMap: map,
  }) as any;

test("non-reasoning model exposes only off", () => {
  assert.deepEqual(
    getSupportedThinkingLevels({ id: "m", reasoning: false } as any),
    ["off"],
  );
});

test("extended levels are opt-in", () => {
  const levels = getSupportedThinkingLevels(
    reasoningModel({ off: "none", high: "high" }),
  );
  assert.ok(!levels.includes("xhigh"));
  assert.ok(!levels.includes("max"));
  assert.ok(levels.includes("high"));
});

test("explicitly unsupported level is excluded", () => {
  const levels = getSupportedThinkingLevels(
    reasoningModel({ off: null, low: "low", high: "high" }),
  );
  assert.ok(!levels.includes("off"));
  assert.ok(levels.includes("low"));
});

test("hole case clamps upward", () => {
  const model = reasoningModel({
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
  assert.equal(clampThinkingLevel(model, "xhigh"), "max");
});

test("clamp snaps an explicitly unsupported level upward", () => {
  const model = reasoningModel({
    off: "none",
    minimal: null,
    low: "low",
    high: "high",
  });
  assert.equal(clampThinkingLevel(model, "minimal"), "low");
});

test("clamp returns requested when supported", () => {
  const model = reasoningModel({ off: "none", medium: "medium" });
  assert.equal(clampThinkingLevel(model, "medium"), "medium");
});

test("non-reasoning clamp yields off", () => {
  assert.equal(
    clampThinkingLevel({ id: "m", reasoning: false } as any, "high"),
    "off",
  );
});
