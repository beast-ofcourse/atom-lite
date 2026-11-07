import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * A boxed user message: a distinct background colour so user input is easy to
 * separate from tool-call panels (which use a dark-gray background).
 */
export class UserBox implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const w = Math.max(8, Math.floor(width));
    const USER_BG = "\x1b[48;5;24m";
    const USER_FG = "\x1b[38;5;255m";
    const USER_BG_RESET = "\x1b[49m";
    const USER_FG_RESET = "\x1b[39m";
    const fill = (line: string): string => {
      const pad = Math.max(0, w - visibleWidth(line));
      return `${USER_BG}${USER_FG}${line}${" ".repeat(pad)}${USER_FG_RESET}${USER_BG_RESET}`;
    };
    const lines: string[] = [];
    for (const raw of this.text.split("\n")) {
      for (const line of wrapTextWithAnsi(raw, w - 2)) {
        lines.push(fill(` ${line}`));
      }
    }
    if (lines.length === 0) lines.push(fill(""));
    return lines;
  }
}
