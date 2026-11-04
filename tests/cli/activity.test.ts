import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_VERBS,
  Activity,
  formatElapsed,
} from "../../dist/cli/activity.js";

test("activity formats elapsed durations compactly", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(4_900), "4s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
});

test("activity moves from ready through thinking/working and back to ready", () => {
  let now = 0;
  const activity = new Activity({
    now: () => now,
    frameIntervalMs: 100,
    verbIntervalMs: 1000,
  });
  assert.match(activity.text(), /ready/);

  activity.start("thinking");
  assert.match(activity.text(), /Thinking…/);
  assert.match(activity.text(), /0s/);

  now = 2500;
  activity.setPhase("working", "bash");
  assert.match(
    activity.text(),
    /Working…|Cooking…|Crafting…|Building…|Brewing…/,
  );
  assert.match(activity.text(), /2s/);
  assert.match(activity.text(), /bash/);

  activity.stop();
  assert.match(activity.text(), /ready/);
});

test("activity exposes the playful verb pools", () => {
  assert.ok(ACTIVITY_VERBS.working.includes("cooking"));
  assert.ok(ACTIVITY_VERBS.thinking.includes("thinking"));
  assert.ok(ACTIVITY_VERBS.formulating.includes("formulating"));
});
