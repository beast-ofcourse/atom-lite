import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Shared ANSI helpers for the small hand-drawn panels in the TUI. */
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const GRAY = "\x1b[90m";

export type Color = (text: string) => string;

export const dim: Color = (text) => `${DIM}${text}${RESET}`;
export const bold: Color = (text) => `${BOLD}${text}${RESET}`;
export const red: Color = (text) => `${RED}${text}${RESET}`;
export const green: Color = (text) => `${GREEN}${text}${RESET}`;
export const yellow: Color = (text) => `${YELLOW}${text}${RESET}`;
export const blue: Color = (text) => `${BLUE}${text}${RESET}`;
export const magenta: Color = (text) => `${MAGENTA}${text}${RESET}`;
export const cyan: Color = (text) => `${CYAN}${text}${RESET}`;
export const gray: Color = (text) => `${GRAY}${text}${RESET}`;

/** Draw the top edge of a panel, embedding a title in the border. */
export function panelTop(label: string, width: number, color: Color): string {
  const inner = Math.max(0, Math.floor(width) - 2);
  const title = truncateToWidth(` ${label} `, inner, "…");
  const fill = Math.max(0, inner - visibleWidth(title));
  return color(`╭${title}${"─".repeat(fill)}╮`);
}

/** Draw the bottom edge of a panel. */
export function panelBottom(width: number, color: Color): string {
  const inner = Math.max(0, Math.floor(width) - 2);
  return color(`╰${"─".repeat(inner)}╯`);
}

/** Draw one body row, padding it to the panel's inner width. */
export function panelRow(content: string, width: number, color: Color): string {
  const inner = Math.max(0, Math.floor(width) - 2);
  const text = truncateToWidth(content, inner, "…", true);
  return `${color("│")}${text}${color("│")}`;
}

/** Wrap plain or ANSI-styled text for a panel's inner width. */
export function wrapPanelText(text: string, width: number): string[] {
  const inner = Math.max(1, Math.floor(width) - 2);
  return text
    .replace(/\t/g, "  ")
    .split("\n")
    .flatMap((line) =>
      line.length === 0 ? [""] : wrapTextWithAnsi(line, inner),
    );
}
