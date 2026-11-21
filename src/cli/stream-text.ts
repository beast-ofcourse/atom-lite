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
  /** Pre-created once; reusing it avoids a layout rebuild on the first token. */
  private readonly live: Markdown;
  private readonly markdownTheme: MarkdownTheme;

  constructor(
    private readonly transcript: Transcript,
    private readonly maxLines = STREAM_LIVE_LINES,
    private readonly sealBatch = STREAM_SEAL_BATCH,
    markdownTheme?: MarkdownTheme,
  ) {
    this.markdownTheme = markdownTheme ?? DEFAULT_MARKDOWN_THEME;
    this.live = new Markdown("", 0, 0, this.markdownTheme);
    // Warm the markdown lexer at common widths. The first real token otherwise
    // pays a ~40 ms JIT/parse cost that shows up as visible jank.
    this.live.setText("answer line 0 content token 123 padding\n");
    for (const warmWidth of [60, 80, 100, 120, 160, 200]) {
      this.live.render(warmWidth);
    }
    this.live.setText("");
    this.transcript.add(this.live);
  }

  append(delta: string): void {
    this.buffer += delta;
    const cut = sealPoint(this.buffer, this.maxLines, this.sealBatch);
    if (cut > 0) {
      const sealed = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      this.seal(sealed);
    }
    this.live.setText(this.buffer);
  }

  /** Insert a sealed block immediately before the live block, keeping order. */
  private seal(text: string): void {
    if (!text) return;
    const markdown = new Markdown(
      renderMermaidBlocks(text),
      0,
      0,
      this.markdownTheme,
    );
    const children = this.transcript.container.children;
    const index = children.indexOf(this.live);
    if (index >= 0) children.splice(index, 0, markdown);
    else children.push(markdown);
    this.transcript.markStructureChanged();
  }

  finalize(): void {
    if (this.buffer) {
      try {
        this.seal(renderMermaidBlocks(this.buffer));
      } catch {
        // Keep the raw text if mermaid rendering fails.
        this.seal(this.buffer);
      }
    }
    this.buffer = "";
    this.live.setText("");
  }
}
