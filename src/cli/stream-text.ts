import { Text } from "@earendil-works/pi-tui";
import type { Transcript } from "./transcript.js";

/** Lines kept live while streaming; older lines are sealed into cached Text. */
export const STREAM_LIVE_LINES = 200;
/** Extra live lines tolerated before a batch is sealed. */
export const STREAM_SEAL_BATCH = 200;

/**
 * Incremental assistant text renderer. Completed lines are moved out of the
 * live Text into static components, so each frame only re-wraps a bounded tail
 * even when the message grows to thousands of lines. Sealing happens in
 * batches, which keeps the number of components small as well.
 */
export class StreamText {
  private buffer = "";
  private live: Text | null = null;

  constructor(
    private readonly transcript: Transcript,
    private readonly maxLines = STREAM_LIVE_LINES,
    private readonly sealBatch = STREAM_SEAL_BATCH,
  ) {}

  append(delta: string): void {
    this.buffer += delta;
    const lines = this.buffer.split("\n");
    if (lines.length > this.maxLines + this.sealBatch) {
      const keepCount = this.maxLines;
      const sealed = lines.slice(0, lines.length - keepCount).join("\n");
      this.buffer = lines.slice(-keepCount).join("\n");
      if (this.live) this.transcript.container.removeChild(this.live);
      this.transcript.add(new Text(sealed));
      this.live = new Text(this.buffer);
      this.transcript.add(this.live);
    } else {
      if (!this.live) {
        this.live = new Text("");
        this.transcript.add(this.live);
      }
      this.live.setText(this.buffer);
    }
  }

  /** Stop this message; its rendered text stays in the transcript. */
  finalize(): void {
    this.buffer = "";
    this.live = null;
  }
}
