import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";

/** ANSI Shadow "ATOM-LITE" wordmark. */
export const BANNER_LINES = [
  "  █████╗ ████████╗ ██████╗ ███╗   ███╗      ██╗     ██╗████████╗███████╗",
  " ██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║      ██║     ██║╚══██╔══╝██╔════╝",
  " ███████║   ██║   ██║   ██║██╔████╔██║█████╗██║     ██║   ██║   █████╗  ",
  " ██╔══██║   ██║   ██║   ██║██║╚██╔╝██║╚════╝██║     ██║   ██║   ██╔══╝  ",
  " ██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║      ███████╗██║   ██║   ███████╗",
  " ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝      ╚══════╝╚═╝   ╚═╝   ╚══════╝ ",
].map((line) => line.trimEnd());

/** Centered startup banner, coloured through the banner theme token. */
export class Banner implements Component {
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

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
      return " ".repeat(pad) + this.theme.tokens.banner(art);
    });
  }
}
