import type { Component } from "@earendil-works/pi-tui";
import { green, red, cyan, dim } from "./panel.js";
import { wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

const TOOL_BG = "\x1b[48;5;236m";
const TOOL_BG_RESET = "\x1b[49m";

function fillBg(line: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(line));
  return `${TOOL_BG}${line}${" ".repeat(pad)}${TOOL_BG_RESET}`;
}

/** Colorize a single unified-diff line. */
export function colorizeDiff(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return dim(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("@@")) return cyan(line);
  return line;
}

export interface DiffViewOptions {
  lines: string[];
  path?: string;
  /** Maximum number of diff lines to render before truncating. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 400;

export class DiffView implements Component {
  private lines: string[];
  private path: string | undefined;
  private maxLines: number;

  constructor(options: DiffViewOptions) {
    this.lines = options.lines ?? [];
    this.path = options.path;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  }

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  invalidate(): void {
    // No cached render state.
  }

  render(width: number): string[] {
    const w = Math.max(8, Math.floor(width));
    const out: string[] = [];
    const added = this.lines.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++"),
    ).length;
    const removed = this.lines.filter(
      (l) => l.startsWith("-") && !l.startsWith("---"),
    ).length;
    const label = this.path
      ? `diff · ${this.path}  +${added} -${removed}`
      : `diff  +${added} -${removed}`;
    out.push(fillBg(` ${dim(label)}`, w));
    out.push(fillBg("", w));

    if (this.lines.length === 0) {
      out.push(fillBg(` ${dim("(no changes)")}`, w));
      out.push(fillBg("", w));
      return out;
    }

    const cap = Math.min(this.maxLines, this.lines.length);
    for (let i = 0; i < cap; i++) {
      const colored = colorizeDiff(this.lines[i]);
      for (const wrapped of wrapTextWithAnsi(colored, w - 2)) {
        out.push(fillBg(` ${wrapped}`, w));
      }
    }
    if (this.lines.length > cap) {
      out.push(fillBg(` ${dim(`… ${this.lines.length - cap} more lines truncated`)}`, w));
    }
    out.push(fillBg("", w));
    return out;
  }
}
