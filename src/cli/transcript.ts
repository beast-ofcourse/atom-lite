import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";

/** Soft cap on rendered transcript children before the oldest are collapsed. */
export const TRANSCRIPT_MAX_CHILDREN = 1500;
/** How many children to collapse when the cap is exceeded. */
export const TRANSCRIPT_PRUNE_COUNT = 500;

/**
 * Append-only transcript with bounded rendering work. The session store keeps
 * the full history; this only limits what the TUI keeps as live components.
 */
class TranscriptContainer extends Container {
  version = 0;
  private cachedVersion = -1;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  bump(): void {
    this.version++;
    this.cachedVersion = -1;
  }

  override addChild(component: Component): void {
    super.addChild(component);
    this.bump();
  }

  override removeChild(component: Component): void {
    super.removeChild(component);
    this.bump();
  }

  override clear(): void {
    super.clear();
    this.bump();
  }

  override render(width: number): string[] {
    if (this.cachedVersion === this.version && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines = super.render(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    return lines;
  }
}

export class Transcript {
  readonly container = new TranscriptContainer();
  private hidden = 0;
  private marker: Text | null = null;
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    if (this.marker) {
      this.marker.setText(this.markerLabel());
    }
    (this.container as TranscriptContainer).bump();
  }

  /** Invalidate the rendered-line cache after a child mutates in place. */
  invalidate(): void {
    (this.container as TranscriptContainer).bump();
  }

  /** Clear all history and pruning state, e.g. when resuming a session. */
  reset(): void {
    this.container.clear();
    this.hidden = 0;
    this.marker = null;
  }

  get hiddenCount(): number {
    return this.hidden;
  }

  add(child: Component): void {
    this.container.addChild(child);
    this.pruneIfNeeded();
    (this.container as TranscriptContainer).bump();
  }

  /** Add a plain transcript line using the theme's text token. */
  addLine(text: string): void {
    this.add(new Text(this.theme.tokens.text(text)));
  }

  private markerLabel(): string {
    return this.theme.tokens.dim(
      `… ${this.hidden} earlier lines hidden (session retains full history)`,
    );
  }

  private pruneIfNeeded(): void {
    const start = this.marker ? 1 : 0;
    if (this.container.children.length - start <= TRANSCRIPT_MAX_CHILDREN)
      return;
    const removable = Math.min(
      TRANSCRIPT_PRUNE_COUNT,
      this.container.children.length - start - 1,
    );
    if (removable <= 0) return;

    this.container.children.splice(start, removable);
    this.hidden += removable;
    const label = this.markerLabel();
    if (this.marker) {
      this.marker.setText(label);
    } else {
      this.marker = new Text(label);
      this.container.children.unshift(this.marker);
    }
    (this.container as TranscriptContainer).bump();
  }
}
