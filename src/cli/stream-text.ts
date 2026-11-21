import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Transcript } from "./transcript.js";
import { renderMermaidBlocks } from "./mermaid.js";

/** Lines kept live while streaming; older lines are sealed into cached Markdown. */
export const STREAM_LIVE_LINES = 40;
/** Extra live lines tolerated before a batch is sealed. */
export const STREAM_SEAL_BATCH = 40;
const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
  codeBlockIndent: "  ",
};

/** Cut only at a blank line outside a fence, including the budget fallback. */
function sealPoint(text: string, maxLines: number, sealBatch: number): number {
  const lines = text.split("\n");
  const keep = Math.max(1, maxLines);
  const budgetIndex =
    lines.length > maxLines + sealBatch ? lines.length - keep - 1 : -1;
  let fenced = false;
  let offset = 0;
  let boundary = 0;
  let budgetCut = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fenced = !fenced;
    offset += line.length + 1;
    if (fenced) continue;
    if (line.trim() === "") boundary = offset;
    if (i === budgetIndex) budgetCut = offset;
  }
  return Math.max(boundary, budgetCut);
}

export class StreamText {
  private buffer = "";
  private live: Markdown | null = null;
  private readonly markdownTheme: MarkdownTheme;

  constructor(
    private readonly transcript: Transcript,
    private readonly maxLines = STREAM_LIVE_LINES,
    private readonly sealBatch = STREAM_SEAL_BATCH,
    markdownTheme?: MarkdownTheme,
  ) {
    this.markdownTheme = markdownTheme ?? DEFAULT_MARKDOWN_THEME;
  }

  append(delta: string): void {
    this.buffer += delta;
    const cut = sealPoint(this.buffer, this.maxLines, this.sealBatch);
    if (cut > 0) {
      const sealed = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      this.seal(sealed);
    }
    if (!this.live) {
      this.live = new Markdown("", 0, 0, this.markdownTheme);
      this.transcript.add(this.live);
    }
    this.live.setText(this.buffer);
  }

  private seal(text: string): void {
    const markdown = new Markdown(
      renderMermaidBlocks(text),
      0,
      0,
      this.markdownTheme,
    );
    if (this.live) this.transcript.container.removeChild(this.live);
    this.transcript.add(markdown);
    this.live = null;
  }

  finalize(): void {
    if (this.live) {
      try {
        this.live.setText(renderMermaidBlocks(this.buffer));
      } catch {
        // Keep the raw text if mermaid rendering fails.
      }
    }
    this.buffer = "";
    this.live = null;
  }
}
