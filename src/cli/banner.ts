import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Block-letter "ATOM-LITE" wordmark. */
export const BANNER_LINES = [
  "  #   #####  ###  #   #       #     ##### ##### #####",
  " # #    #   #   # ## ##       #       #     #   #    ",
  "#####   #   #   # # # #  ###  #       #     #   #### ",
  "#   #   #   #   # #   #       #       #     #   #    ",
  "#   #   #    ###  #   #       ##### #####   #   #####",
];

const RED = "\x1b[1;31m";
const RESET = "\x1b[0m";

/** Centered, bold-red startup banner. */
export class Banner implements Component {
  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    return BANNER_LINES.map((line) => {
      const art = truncateToWidth(line, w);
      const pad = Math.max(0, Math.floor((w - visibleWidth(art)) / 2));
      return " ".repeat(pad) + RED + art + RESET;
    });
  }
}
