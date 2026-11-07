import type { Component } from "@earendil-works/pi-tui";
import {
  green,
  red,
  cyan,
  dim,
  bold,
  gray,
  type Color,
} from "./panel.js";
import { wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

const TOOL_BG = "\x1b[48;5;236m";
const ADDED_BG = "\x1b[48;5;22m";
const REMOVED_BG = "\x1b[48;5;52m";
const BG_RESET = "\x1b[49m";

function fillBg(line: string, width: number, bg: string = TOOL_BG): string {
  const pad = Math.max(0, width - visibleWidth(line));
  return `${bg}${line}${" ".repeat(pad)}${BG_RESET}`;
}

function lineBg(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return ADDED_BG;
  if (line.startsWith("-") && !line.startsWith("---")) return REMOVED_BG;
  return TOOL_BG;
}

/** Colorize a single unified-diff line. */
export function colorizeDiff(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return dim(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("@@")) return bold(cyan(line));
  return gray(line.startsWith(" ") ? line : line);
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
  private added = 0;
  private removed = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;

  constructor(options: DiffViewOptions) {
    this.lines = options.lines ?? [];
    this.path = options.path;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.recomputeStats();
  }

  setLines(lines: string[]): void {
    this.lines = lines;
    this.recomputeStats();
    this.invalidate();
  }

  private recomputeStats(): void {
    let added = 0;
    let removed = 0;
    for (const l of this.lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) added++;
      else if (l.startsWith("-") && !l.startsWith("---")) removed++;
    }
    this.added = added;
    this.removed = removed;
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    const w = Math.max(8, Math.floor(width));
    if (this.cachedLines && this.cachedWidth === w) return this.cachedLines;

    const out: string[] = [];
    const label = this.path
      ? `diff · ${this.path}`
      : "diff";
    const header = ` ${bold(label)}  ${green(`+${this.added}`)} ${red(`-${this.removed}`)}`;
    out.push(fillBg(header, w));
    out.push(fillBg("", w));

    if (this.lines.length === 0) {
      out.push(fillBg(` ${dim("(no changes)")}`, w));
      out.push(fillBg("", w));
      this.cachedLines = out;
      this.cachedWidth = w;
      return out;
    }

    const cap = Math.min(this.maxLines, this.lines.length);
    for (let i = 0; i < cap; i++) {
      const colored = colorizeDiff(this.lines[i]);
      const bg = lineBg(this.lines[i]);
      const wrapped = wrapTextWithAnsi(colored, Math.max(2, w - 2));
      for (let j = 0; j < wrapped.length; j++) {
        const prefix = j === 0 ? " " : "  ";
        out.push(fillBg(`${prefix}${wrapped[j]}`, w, bg));
      }
    }
    if (this.lines.length > cap) {
      out.push(
        fillBg(
          ` ${dim(`… ${this.lines.length - cap} more lines truncated`)}`,
          w,
        ),
      );
    }
    out.push(fillBg("", w));
    this.cachedLines = out;
    this.cachedWidth = w;
    return out;
  }
}
