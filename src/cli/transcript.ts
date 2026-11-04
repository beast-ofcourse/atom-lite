import { Container, Text, type Component } from "@earendil-works/pi-tui";

/** Soft cap on rendered transcript children before the oldest are collapsed. */
export const TRANSCRIPT_MAX_CHILDREN = 1500;
/** How many children to collapse when the cap is exceeded. */
export const TRANSCRIPT_PRUNE_COUNT = 500;

/**
 * Append-only transcript with bounded rendering work. The session store keeps
 * the full history; this only limits what the TUI keeps as live components.
 */
export class Transcript {
  readonly container = new Container();
  private hidden = 0;
  private marker: Text | null = null;

  get hiddenCount(): number {
    return this.hidden;
  }

  add(child: Component): void {
    this.container.addChild(child);
    this.pruneIfNeeded();
  }

  private pruneIfNeeded(): void {
    const start = this.marker ? 1 : 0;
    if (this.container.children.length - start <= TRANSCRIPT_MAX_CHILDREN) return;
    const removable = Math.min(
      TRANSCRIPT_PRUNE_COUNT,
      this.container.children.length - start - 1,
    );
    if (removable <= 0) return;

    this.container.children.splice(start, removable);
    this.hidden += removable;
    const label = `\x1b[2m… ${this.hidden} earlier lines hidden (session retains full history)\x1b[0m`;
    if (this.marker) {
      this.marker.setText(label);
    } else {
      this.marker = new Text(label);
      this.container.children.unshift(this.marker);
    }
  }
}
