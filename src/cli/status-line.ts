import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface StatusLineParts {
  left: string;
  tokens: string;
  effort: string;
}

/**
 * Lay out the status line: provider on the left, tokens at roughly one third of
 * the remaining space, and effort hard against the right edge.
 */
export function formatStatusLine(
  left: string,
  tokens: string,
  right: string,
  width: number,
): string {
  const w = Math.max(1, Math.floor(width));
  const free = w - visibleWidth(left) - visibleWidth(tokens) - visibleWidth(right);
  if (free < 4) {
    return truncateToWidth(`${left} ${tokens} ${right}`, w, "…");
  }
  const leftGap = Math.max(1, Math.floor(free * 0.3));
  const rightGap = Math.max(1, free - leftGap);
  return `${left}${" ".repeat(leftGap)}${tokens}${" ".repeat(rightGap)}${right}`;
}

/** Single-component status bar that always right-aligns the effort label. */
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
    const line = formatStatusLine(
      this.parts.left,
      this.parts.tokens,
      this.parts.effort,
      contentWidth,
    );
    const padding = Math.max(0, width - visibleWidth(line) - 1);
    return [" " + line + " ".repeat(padding)];
  }
}
