// Contract: the goal panel renders runtime state, follows visibility/toggle
// rules, shows paused and completed states, and applies theme changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { GoalPanel } from "../../dist/cli/goal-panel.js";
import {
  ansiTheme,
  darkTheme,
  lightTheme,
  nordTheme,
} from "../../dist/cli/theme.js";
import type { GoalState } from "../../dist/runtime/goal.js";
import type { TodoItem } from "../../dist/runtime/todos.js";

const goal: GoalState = {
  statement: "Ship the feature",
  criteria: ["tests pass", "docs updated"],
  status: "active",
  constraints: "no new dependencies",
};

const todos: TodoItem[] = [
  { id: "T1", content: "tests pass", status: "completed" },
  { id: "T2", content: "write docs", status: "in_progress" },
];

function plain(panel: GoalPanel, width = 50): string {
  return panel.render(width).map(stripTerminalSequences).join("\n");
}

test("panel renders goal, status, criteria, and todo statuses", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState(goal, todos);
  const output = plain(panel);
  assert.match(output, /Goal/);
  assert.match(output, /Statement: Ship the feature/);
  assert.match(output, /Status: active/);
  assert.match(output, /\[x\] tests pass/);
  assert.match(output, /\[ \] docs updated/);
  assert.match(output, /Constraints: no new dependencies/);
  assert.match(output, /T1: tests pass/);
  assert.match(output, /T2: write docs/);
});

test("panel is hidden without state and appears when state exists", () => {
  const panel = new GoalPanel(ansiTheme);
  assert.equal(panel.isVisible, false);
  assert.deepEqual(panel.render(40), []);
  panel.setState(goal, []);
  assert.equal(panel.isVisible, true);
  assert.match(plain(panel), /Ship the feature/);
});

test("panel shows paused state and updates on new state", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState(goal, todos);
  panel.setState({ ...goal, status: "paused" }, todos);
  assert.match(plain(panel), /Status: paused/);
});

test("toggle hides and restores without losing state", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState(goal, todos);
  assert.equal(panel.toggle(), false);
  assert.deepEqual(panel.render(40), []);
  assert.equal(panel.toggle(), true);
  assert.match(plain(panel), /Ship the feature/);
});

test("theme changes apply to the panel", () => {
  const panel = new GoalPanel(darkTheme);
  panel.setState(goal, todos);
  const themed = panel.render(50).join("\n");
  assert.ok(themed.includes(darkTheme.tokens.border("│")));
  panel.setTheme(nordTheme);
  const nord = panel.render(50).join("\n");
  assert.ok(nord.includes(nordTheme.tokens.border("│")));
  panel.setTheme(ansiTheme);
  for (const row of panel.render(50)) {
    assert.equal(stripTerminalSequences(row), row);
  }
});

test("a completed goal ticks every criterion", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState({ ...goal, status: "complete" }, todos);
  const output = plain(panel);
  assert.match(output, /\[x\] tests pass/);
  assert.match(output, /\[x\] docs updated/);
});

// Contract: the sidebar fills its allocated columns with a theme-appropriate
// background. The fill must survive nested style resets and must stay empty for
// the no-colour theme, while leaving visible width unchanged.
test("coloured themes paint the sidebar background across every row", () => {
  const dark = new GoalPanel(darkTheme);
  dark.setState(goal, todos);
  for (const row of dark.render(50)) {
    assert.ok(row.includes("\x1b[48;5;236m"), "dark background missing");
    assert.ok(row.startsWith("\x1b[48;5;236m"), "row does not start filled");
  }

  const light = new GoalPanel(lightTheme);
  light.setState(goal, todos);
  for (const row of light.render(50)) {
    assert.ok(row.includes("\x1b[48;5;252m"), "light background missing");
  }
});

test("background fill survives inner style resets", () => {
  const panel = new GoalPanel(darkTheme);
  panel.setState({ ...goal, status: "paused" }, todos);
  const rendered = panel.render(50).join("\n");
  assert.ok(
    rendered.includes("\x1b[0m\x1b[48;5;236m"),
    "background lost after a style reset",
  );
});

test("background fill does not change visible width", () => {
  const panel = new GoalPanel(darkTheme);
  panel.setState(goal, todos);
  for (const row of panel.render(40)) {
    assert.equal(visibleWidth(row), 40);
  }
});

test("panel rows never exceed the allocated width", () => {
  const panel = new GoalPanel(ansiTheme);
  panel.setState(
    { ...goal, statement: "A very long statement ".repeat(10) },
    todos,
  );
  for (const row of panel.render(30)) {
    assert.ok(visibleWidth(row) <= 30);
  }
});
