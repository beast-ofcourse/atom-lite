// Regression: the goal panel must keep a fixed basis in the horizontal split.
// Without it the panel's intrinsic width consumes the viewport and the
// transcript renders zero columns wide, hiding every assistant answer after
// an approved tool call.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { LAYOUT_NODE } from "@earendil-works/pi-tui/dist/layout-node.js";
import { allocateStackSizes } from "@earendil-works/pi-tui/dist/components/stack.js";
import { createMainRow, GOAL_PANEL_WIDTH } from "../../dist/cli/main-layout.js";
import { GoalPanel } from "../../dist/cli/goal-panel.js";
import { ansiTheme } from "../../dist/cli/theme.js";

const output: Component = {
  render: () => [""],
  invalidate: () => {},
};

test("goal panel gets a fixed width so the transcript keeps the rest", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState(
    {
      statement: "Ship it",
      criteria: [],
      status: "active",
    },
    [],
  );
  const row = createMainRow(output, panel);
  const node = (row as any)[LAYOUT_NODE]();
  assert.equal(node.type, "hstack");
  assert.equal(node.entries.length, 2);
  assert.equal(node.entries[1].basis, GOAL_PANEL_WIDTH);
  assert.equal(node.entries[1].maxSize, GOAL_PANEL_WIDTH);

  // Simulate the panel reporting the whole viewport as its intrinsic width.
  const sizes = allocateStackSizes(node.entries, [0, 80], 80, node.gap);
  assert.equal(sizes[1], GOAL_PANEL_WIDTH);
  assert.ok(sizes[0] >= 40, `transcript width ${sizes[0]}`);
});

test("panel visibility follows goal and todo state", () => {
  const panel = new GoalPanel(ansiTheme);
  const row = createMainRow(output, panel);
  const node = (row as any)[LAYOUT_NODE]();
  assert.equal(node.entries[1].visible({ width: 80, height: 24 }), false);
  panel.setState({ statement: "Ship", criteria: [], status: "active" }, []);
  assert.equal(node.entries[1].visible({ width: 80, height: 24 }), true);
});
