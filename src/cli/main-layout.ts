import { HStack, type Component } from "@earendil-works/pi-tui";
import type { GoalPanel } from "./goal-panel.js";

/** Fixed width for the goal panel in the main horizontal split. */
export const GOAL_PANEL_WIDTH = 34;

/**
 * Build the row that holds the transcript and the optional goal panel.
 *
 * The panel needs an explicit basis: a component without one reports the full
 * viewport as its intrinsic width, which squeezes the transcript to zero
 * columns and hides every assistant answer after a tool call.
 */
export function createMainRow(output: Component, panel: GoalPanel): HStack {
  const row = new HStack([], { gap: 1 });
  row.addChild(output, { grow: 1, shrink: 1, minSize: 0 });
  row.addChild(panel, {
    basis: GOAL_PANEL_WIDTH,
    minSize: GOAL_PANEL_WIDTH,
    maxSize: GOAL_PANEL_WIDTH,
    grow: 0,
    shrink: 0,
    visible: () => panel.isVisible,
  });
  return row;
}
