import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";

export interface StatusLineParts {
  left: string;
  tokens: string;
  effort: string;
  /** Current agent mode, rendered as "mode:<value>" in the top row. */
  mode?: string;
  /** Animated agent state, rendered as an optional third row. Already styled. */
  activity?: string;
}

/**
 * Lay out the top status row: provider/model on the left and effort hard
 * against the right edge. Context tokens get their own row underneath.
 */
export function formatStatusLine(
  left: string,
  right: string,
  width: number,
): string {
  const w = Math.max(1, Math.floor(width));
  const free = w - visibleWidth(left) - visibleWidth(right);
  if (free < 4) {
    return truncateToWidth(`${left} ${right}`, w, "…");
  }
  return `${left}${" ".repeat(free)}${right}`;
}

/** Two-row status bar: provider/model + effort, then context tokens. */
export class StatusLine implements Component {
  private parts: StatusLineParts = { left: "", tokens: "", effort: "" };
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setParts(parts: StatusLineParts): void {
    this.parts = parts;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const tokens = this.theme.tokens;
    const contentWidth = Math.max(1, width - 2);
    const modePart = this.parts.mode
      ? (this.parts.mode === "yolo"
          ? tokens.warning(`mode:${this.parts.mode}`)
          : tokens.accent(`mode:${this.parts.mode}`))
      : "";
    const right = [modePart, tokens.dim(this.parts.effort)]
      .filter(Boolean)
      .join("  ");
    const top = formatStatusLine(
      tokens.status(this.parts.left),
      right,
      contentWidth,
    );
    const bottom = truncateToWidth(tokens.dim(this.parts.tokens), contentWidth);
    const rows = [
      " " + top + " ".repeat(Math.max(0, width - visibleWidth(top) - 1)),
      " " + bottom + " ".repeat(Math.max(0, width - visibleWidth(bottom) - 1)),
    ];
    if (this.parts.activity !== undefined) {
      const activity = truncateToWidth(this.parts.activity, contentWidth);
      rows.push(
        " " +
          activity +
          " ".repeat(Math.max(0, width - visibleWidth(activity) - 1)),
      );
    }
    return rows;
  }
}
