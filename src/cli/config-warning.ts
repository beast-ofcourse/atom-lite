import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";
import { panelBottom, panelRow, panelTop } from "./panel.js";

const MAX_WIDTH = 64;

/** Top-right panel that keeps startup config problems visible in the TUI. */
export class ConfigWarning implements Component {
  private messages: string[] = [];
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  get hasMessages(): boolean {
    return this.messages.length > 0;
  }

  setMessages(messages: string[]): void {
    this.messages = [...messages];
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    if (!this.messages.length) return [];
    const suffix =
      this.messages.length > 1 ? ` (+${this.messages.length - 1} more)` : "";
    const body = `⚠ ${this.messages[0]}${suffix}`;
    const panelWidth = Math.min(
      Math.max(16, visibleWidth(body) + 4),
      MAX_WIDTH,
      Math.max(1, Math.floor(width)),
    );
    const pad = " ".repeat(Math.max(0, Math.floor(width) - panelWidth));
    const border = this.theme.tokens.border;
    const text = this.theme.tokens.warning;
    return [
      pad + panelTop("config", panelWidth, border),
      pad +
        panelRow(
          ` ${text(truncateToWidth(body, panelWidth - 4, "…"))}`,
          panelWidth,
          border,
        ),
      pad + panelBottom(panelWidth, border),
    ];
  }
}
