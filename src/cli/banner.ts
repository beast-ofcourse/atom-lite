import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** ANSI Shadow "ATOM-LITE" wordmark. */
export const BANNER_LINES = [
  "  █████╗ ████████╗ ██████╗ ███╗   ███╗      ██╗     ██╗████████╗███████╗",
  " ██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║      ██║     ██║╚══██╔══╝██╔════╝",
  " ███████║   ██║   ██║   ██║██╔████╔██║█████╗██║     ██║   ██║   █████╗  ",
  " ██╔══██║   ██║   ██║   ██║██║╚██╔╝██║╚════╝██║     ██║   ██║   ██╔══╝  ",
  " ██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║      ███████╗██║   ██║   ███████╗",
  " ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝      ╚══════╝╚═╝   ╚═╝   ╚══════╝ ",
].map((line) => line.trimEnd());

const RED = "\x1b[1;31m";
const RESET = "\x1b[0m";

/** Centered, bold-red startup banner. */
export class Banner implements Component {
  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    // Center the block as a whole so shorter rows keep their relative shape.
    const blockWidth = Math.min(
      w,
      Math.max(...BANNER_LINES.map((line) => visibleWidth(line))),
    );
    const pad = Math.max(0, Math.floor((w - blockWidth) / 2));
    return BANNER_LINES.map((line) => {
      const art = truncateToWidth(line, blockWidth);
      return " ".repeat(pad) + RED + art + RESET;
    });
  }
}
