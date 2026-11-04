import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface StatusLineParts {
  left: string;
  tokens: string;
  effort: string;
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

  setParts(parts: StatusLineParts): void {
    this.parts = parts;
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const top = formatStatusLine(
      this.parts.left,
      this.parts.effort,
      contentWidth,
    );
    const bottom = truncateToWidth(this.parts.tokens, contentWidth);
    const topPadding = Math.max(0, width - visibleWidth(top) - 1);
    const bottomPadding = Math.max(0, width - visibleWidth(bottom) - 1);
    return [
      " " + top + " ".repeat(topPadding),
      " " + bottom + " ".repeat(bottomPadding),
    ];
  }
}
