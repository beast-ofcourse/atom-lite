import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";

/** Soft cap on rendered transcript children before the oldest are collapsed. */
export const TRANSCRIPT_MAX_CHILDREN = 400;
/** How many children to collapse when the cap is exceeded. */
export const TRANSCRIPT_PRUNE_COUNT = 150;

export class Transcript {
  readonly container = new Container();
  private hidden = 0;
  private marker: Text | null = null;
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    for (const child of this.container.children) child.invalidate?.();
    if (this.marker) this.marker.setText(this.markerLabel());
  }

  reset(): void {
    this.container.clear();
    this.hidden = 0;
    this.marker = null;
    this.markStructureChanged();
  }

  /** Drop the child-height layout after a structural change. */
  markStructureChanged(): void {
    const container = this.container as unknown as {
      childLines?: unknown;
      mouseLayout?: unknown;
    };
    container.childLines = undefined;
    container.mouseLayout = undefined;
  }

  get hiddenCount(): number {
    return this.hidden;
  }

  add(child: Component): void {
    this.container.addChild(child);
    this.pruneIfNeeded();
    this.markStructureChanged();
  }

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
  }
}
