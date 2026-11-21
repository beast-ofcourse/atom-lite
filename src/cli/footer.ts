import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "../providers/context-window.js";
import { darkTheme, type Theme } from "./theme.js";

export interface FooterParts {
  pwd: string;
  used?: number;
  window?: number;
  percent?: number | null;
  model: string;
  reasoning?: boolean;
  thinkingLevel?: string;
  autoCompact?: boolean;
  extraStats?: string[];
}

export class Footer implements Component {
  private parts: FooterParts = { pwd: "", model: "" };
  private theme: Theme;

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setParts(parts: FooterParts): void {
    this.parts = parts;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme.tokens;
    const contentWidth = Math.max(1, width - 2);
    const pwdLine = truncateToWidth(t.dim(this.parts.pwd), contentWidth, t.dim("..."));

    const contextWindow = this.parts.window ?? 0;
    const percent = this.parts.percent;
    const autoIndicator = this.parts.autoCompact ? " (auto)" : "";
    const percentText =
      percent === null || percent === undefined
        ? "?"
        : percent.toFixed(1);
    const contextDisplay =
      percent === null || percent === undefined
        ? `?/${formatTokens(contextWindow)}${autoIndicator}`
        : `${percentText}%/${formatTokens(contextWindow)}${autoIndicator}`;

    const contextValue = percent ?? 0;
    let contextStr = contextDisplay;
    if (contextValue > 90) contextStr = t.error(contextDisplay);
    else if (contextValue > 70) contextStr = t.warning(contextDisplay);

    const statsParts = [...(this.parts.extraStats ?? []), contextStr];

    let rightSide = this.parts.model || "no-model";
    if (this.parts.reasoning) {
      const level = this.parts.thinkingLevel || "off";
      rightSide =
        level === "off"
          ? `${rightSide} • thinking off`
          : `${rightSide} • ${level}`;
    }

    const statsLeft = statsParts.join(" ");
    let statsLeftWidth = visibleWidth(statsLeft);
    if (statsLeftWidth > width) {
      // truncate
    }
    const rightWidth = visibleWidth(rightSide);
    const minPadding = 2;
    const totalNeeded = statsLeftWidth + minPadding + rightWidth;
    let statsLine: string;
    if (totalNeeded <= width) {
      const padding = " ".repeat(width - statsLeftWidth - rightWidth);
      statsLine = statsLeft + padding + rightSide;
    } else {
      const availableForRight = width - statsLeftWidth - minPadding;
      if (availableForRight > 0) {
        const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
        const truncatedWidth = visibleWidth(truncatedRight);
        const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedWidth));
        statsLine = statsLeft + padding + truncatedRight;
      } else {
        statsLine = statsLeft;
      }
    }

    const dimStatsLeft = t.dim(statsLeft);
    const remainder = statsLine.slice(statsLeft.length);
    const dimRemainder = t.dim(remainder);

    return [pwdLine, dimStatsLeft + dimRemainder];
  }
}
