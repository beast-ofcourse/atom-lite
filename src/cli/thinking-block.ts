import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";

/**
 * Streaming thinking view. Complete lines are wrapped once and kept; only the
 * final partial line is re-wrapped as tokens arrive, so a long reasoning stream
 * stays O(delta) per frame instead of re-wrapping the whole buffer.
 */
export class ThinkingBlock {
  private text = "";
  private sealedChars = 0;
  private sealedLines: string[] = [];
  private tailLines: string[] = [];
  private cachedTail = "";
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;
  private startedAt: number | null = null;
  private endedAt: number | null = null;

  constructor(private theme: Theme = darkTheme) {}

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.invalidate();
  }

  append(delta: string): void {
    if (this.startedAt === null) this.startedAt = Date.now();
    this.text += delta;
  }

  end(): void {
    if (this.startedAt !== null && this.endedAt === null) {
      this.endedAt = Date.now();
    }
  }

  private formatDuration(ms: number): string {
    if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  invalidate(): void {
    this.sealedChars = 0;
    this.sealedLines = [];
    this.cachedTail = "";
    this.tailLines = [];
    this.cachedWidth = -1;
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (width !== this.cachedWidth) {
      this.invalidate();
      this.cachedWidth = width;
    }

    const theme = this.theme;
    const sep = theme.tokens.dim("│ ");
    const contentWidth = Math.max(1, width - 2);
    const newline = this.text.lastIndexOf("\n");
    const sealedBefore = this.sealedChars;
    if (newline + 1 > this.sealedChars) {
      for (const wrapped of wrapTextWithAnsi(
        this.text.slice(this.sealedChars, newline),
        contentWidth,
      )) {
        this.sealedLines.push(sep + theme.tokens.dim(wrapped));
      }
      this.sealedChars = newline + 1;
    }

    const tail = this.text.slice(this.sealedChars);
    const tailChanged = tail !== this.cachedTail;
    if (tailChanged) {
      this.tailLines = wrapTextWithAnsi(tail, contentWidth).map(
        (line) => sep + theme.tokens.dim(line),
      );
      this.cachedTail = tail;
    }

    const elapsed =
      this.startedAt !== null && this.endedAt !== null
        ? this.endedAt - this.startedAt
        : 0;
    const header =
      elapsed > 0
        ? theme.tokens.dim(`💭 thinking - ${this.formatDuration(elapsed)}`)
        : theme.tokens.dim("💭 thinking");
    if (!tailChanged && sealedBefore === this.sealedChars && this.cachedLines) {
      this.cachedLines[0] = header;
      return this.cachedLines;
    }
    this.cachedLines = [header, ...this.sealedLines, ...this.tailLines];
    return this.cachedLines;
  }
}
