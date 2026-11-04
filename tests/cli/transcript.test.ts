import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import {
  Transcript,
  TRANSCRIPT_MAX_CHILDREN,
  TRANSCRIPT_PRUNE_COUNT,
} from "../../dist/cli/transcript.js";

test("transcript keeps a bounded number of live children", () => {
  const t = new Transcript();
  for (let i = 0; i < TRANSCRIPT_MAX_CHILDREN + 200; i++) {
    t.add(new Text(`line ${i}`));
  }
  assert.ok(t.container.children.length <= TRANSCRIPT_MAX_CHILDREN + 1);
  assert.equal(t.hiddenCount, TRANSCRIPT_PRUNE_COUNT);
});

test("transcript collapses the oldest children behind a marker", () => {
  const t = new Transcript();
  for (let i = 0; i < TRANSCRIPT_MAX_CHILDREN + 10; i++) {
    t.add(new Text(`line ${i}`));
  }
  const first = t.container.children[0];
  const lines = first.render(80).join("\n");
  assert.match(lines, /earlier lines hidden \(session retains full history\)/);
  const last = t.container.children[t.container.children.length - 1];
  assert.match(last.render(80).join("\n"), /line 1509/);
});

test("transcript reset clears history and pruning state", () => {
  const t = new Transcript();
  for (let i = 0; i < TRANSCRIPT_MAX_CHILDREN + 10; i++) {
    t.add(new Text(`line ${i}`));
  }
  assert.ok(t.hiddenCount > 0);
  t.reset();
  assert.equal(t.container.children.length, 0);
  assert.equal(t.hiddenCount, 0);
  t.add(new Text("fresh"));
  assert.equal(t.container.children.length, 1);
});

test("transcript prunes repeatedly and updates the marker", () => {
  const t = new Transcript();
  for (let i = 0; i < TRANSCRIPT_MAX_CHILDREN + TRANSCRIPT_PRUNE_COUNT + 200; i++) {
    t.add(new Text(`line ${i}`));
  }
  assert.ok(t.hiddenCount > TRANSCRIPT_PRUNE_COUNT);
  const marker = t.container.children[0].render(80).join("\n");
  assert.match(marker, new RegExp(`… ${t.hiddenCount} earlier lines hidden`));
});
