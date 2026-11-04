import type { Component } from "@earendil-works/pi-tui";
import {
  cyan,
  dim,
  green,
  panelBottom,
  panelRow,
  panelTop,
  red,
  yellow,
  type Color,
  wrapPanelText,
} from "./panel.js";

export type ToolStatus = "running" | "done" | "error";

export interface ToolBoxOptions {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolResultOptions {
  isError?: boolean;
  diff?: string[];
}

const LIVE_TAIL_LINES = 8;
const EXPANDED_LINE_LIMIT = 600;

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A short, human-friendly summary of a tool call's arguments. */
export function formatToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const a = args ?? {};
  if (name === "bash" && typeof a.command === "string") {
    return `$ ${singleLine(a.command)}`;
  }
  for (const key of ["path", "file", "file_path", "url", "query", "pattern"]) {
    const value = a[key];
    if (typeof value === "string" && value.trim()) {
      return `${key}: ${singleLine(value)}`;
    }
  }
  const json = singleLine(JSON.stringify(a));
  return json === "{}" ? "" : json;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function colorizeDiff(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return dim(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("@@")) return cyan(line);
  return line;
}

function tail<T>(items: T[], count: number): T[] {
  return items.length <= count ? items : items.slice(items.length - count);
}

/**
 * A boxed tool call: a cyan call panel followed by a separate output panel whose
 * colour reflects the result (yellow while running, green on success, red on
 * error). Keeping them distinct makes calls and results easy to scan.
 */
export class ToolBox implements Component {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown> | undefined;
  status: ToolStatus = "running";
  private expanded = false;
  private outputLines: string[] = [];
  private outputIsDiff = false;
  private liveBuffer = "";
  private startedAt = Date.now();
  private finishedAt: number | undefined;

  constructor(options: ToolBoxOptions) {
    this.id = options.id;
    this.name = options.name;
    this.args = options.args;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    return this.expanded;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  setResult(content: string, options: ToolResultOptions = {}): void {
    this.status = options.isError ? "error" : "done";
    this.finishedAt = Date.now();
    this.liveBuffer = "";
    this.outputIsDiff = Array.isArray(options.diff);
    this.outputLines = options.diff ?? content.split("\n");
  }

  appendLive(text: string): void {
    this.liveBuffer += text;
    // The completed result carries the full, capped output. Keep the live view
    // bounded so a chatty command cannot pin arbitrarily much text in memory.
    if (this.liveBuffer.length > 60_000) {
      this.liveBuffer = this.liveBuffer.slice(-60_000);
    }
  }

  invalidate(): void {
    // No cached render state.
  }

  render(width: number): string[] {
    const panelWidth = Math.max(8, Math.floor(width));
    const lines: string[] = [];
    const callColor = this.status === "error" ? red : cyan;
    const title = this.title();
    lines.push(panelTop(title, panelWidth, callColor));

    const preview = formatToolArgs(this.name, this.args);
    if (preview) {
      for (const line of wrapPanelText(preview, panelWidth)) {
        lines.push(panelRow(` ${dim(line)}`, panelWidth, callColor));
      }
    }

    if (this.status === "running" && !this.liveBuffer) {
      lines.push(
        panelRow(` ${dim("waiting for output…")}`, panelWidth, callColor),
      );
    }
    lines.push(panelBottom(panelWidth, callColor));

    const output = this.renderedOutput();
    if (output.length > 0) {
      lines.push(...this.renderOutput(output, width));
    }
    return lines;
  }

  private title(): string {
    if (this.status === "running") {
      return `◌ ${this.name} · running`;
    }
    const elapsed = formatDuration(
      (this.finishedAt ?? Date.now()) - this.startedAt,
    );
    return `${this.status === "error" ? "✗" : "✓"} ${this.name} · ${elapsed}`;
  }

  private renderedOutput(): string[] {
    if (this.status === "running") {
      if (!this.liveBuffer) return [];
      const live = this.liveBuffer.replace(/\r/g, "").split("\n");
      const visible = tail(live, LIVE_TAIL_LINES);
      if (live.length > visible.length) {
        return [
          dim(`… ${live.length - visible.length} earlier lines`),
          ...visible,
        ];
      }
      return visible;
    }

    if (this.outputIsDiff) {
      const added = this.outputLines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ).length;
      const removed = this.outputLines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length;
      if (!this.expanded) {
        return [dim(`+${added} -${removed} · ctrl+o to expand`)];
      }
      return this.outputLines.map(colorizeDiff);
    }

    if (!this.expanded) {
      return [dim(`(${this.outputLines.length} lines · ctrl+o to expand)`)];
    }
    if (this.outputLines.length > EXPANDED_LINE_LIMIT) {
      const shown = this.outputLines.slice(0, EXPANDED_LINE_LIMIT);
      return [
        ...shown,
        dim(
          `… ${this.outputLines.length - EXPANDED_LINE_LIMIT} more lines hidden`,
        ),
      ];
    }
    return this.outputLines;
  }

  private renderOutput(output: string[], width: number): string[] {
    const indent = width > 10 ? "  " : "";
    const outputWidth = Math.max(6, Math.floor(width) - indent.length);
    const color: Color =
      this.status === "error"
        ? red
        : this.status === "running"
          ? yellow
          : green;
    const label = this.status === "running" ? "output · live" : "output";
    const lines = [indent + panelTop(label, outputWidth, color)];
    for (const raw of output) {
      const content = raw.length === 0 ? "" : raw;
      for (const line of wrapPanelText(content, outputWidth)) {
        lines.push(indent + panelRow(` ${line}`, outputWidth, color));
      }
    }
    lines.push(indent + panelBottom(outputWidth, color));
    return lines;
  }
}
