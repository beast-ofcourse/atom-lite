import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Transcript } from "./transcript.js";

/** Lines kept live while streaming; older lines are sealed into cached Markdown. */
export const STREAM_LIVE_LINES = 200;
/** Extra live lines tolerated before a batch is sealed. */
export const STREAM_SEAL_BATCH = 200;
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
    const lines = this.buffer.split("\n");
    if (lines.length > this.maxLines + this.sealBatch) {
      const keepCount = this.maxLines;
      const sealed = lines.slice(0, lines.length - keepCount).join("\n");
      this.buffer = lines.slice(-keepCount).join("\n");
      if (this.live) this.transcript.container.removeChild(this.live);
      this.transcript.add(new Markdown(sealed, 0, 0, this.markdownTheme));
      this.live = new Markdown(this.buffer, 0, 0, this.markdownTheme);
      this.transcript.add(this.live);
    } else {
      if (!this.live) {
        this.live = new Markdown("", 0, 0, this.markdownTheme);
        this.transcript.add(this.live);
      }
      this.live.setText(this.buffer);
      this.transcript.invalidate();
    }
  }

  /** Stop this message; its rendered text stays in the transcript. */
  finalize(): void {
    this.buffer = "";
    this.live = null;
  }
}
