import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  type Component,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  cyan,
  dim,
  panelBottom,
  panelRow,
  panelTop,
  red,
  yellow,
} from "./panel.js";
export interface TrustReviewEntry {
  id: string;
  entryPath: string;
  version?: string;
  capabilities: string[];
}

export type ProjectTrustDecision = "approve" | "deny";

/**
 * Modal review for project-local extensions. It defaults to deny and captures
 * input directly so the editor underneath cannot receive the decision keys.
 */
export class ProjectTrustPrompt implements Component {
  private selected = 1; // Safe default: deny.
  private settled = false;

  constructor(
    private readonly entries: TrustReviewEntry[],
    private readonly cwd: string,
    private readonly onDecision: (decision: ProjectTrustDecision) => void,
  ) {}

  invalidate(): void {
    // No cached state.
  }

  handleInput(data: string): void {
    if (this.settled || isKeyRelease(data)) return;

    if (matchesKey(data, "left")) {
      this.selected = 0;
      return;
    }
    if (matchesKey(data, "right")) {
      this.selected = 1;
      return;
    }

    const key = (
      decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined)
    )?.toLowerCase();
    if (key === "y") return this.finish("approve");
    if (key === "n") return this.finish("deny");
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      return this.finish(this.selected === 0 ? "approve" : "deny");
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      return this.finish("deny");
    }
  }

  render(width: number): string[] {
    const panelWidth = Math.max(8, Math.floor(width));
    const inner = panelWidth - 4;
    const lines: string[] = [
      panelTop("project extensions need approval", panelWidth, yellow),
    ];
    for (const line of wrapTextWithAnsi(this.cwd, inner)) {
      lines.push(panelRow(` ${dim(line)}`, panelWidth, yellow));
    }
    for (const entry of this.entries) {
      const label = entry.version
        ? `${entry.id} ${dim(`v${entry.version}`)}`
        : entry.id;
      lines.push(panelRow(` ${cyan(label)}`, panelWidth, yellow));
      for (const line of wrapTextWithAnsi(entry.entryPath, inner)) {
        lines.push(panelRow(`  ${dim(line)}`, panelWidth, yellow));
      }
      const capabilities =
        entry.capabilities.length > 0
          ? entry.capabilities.join(", ")
          : "no declared capabilities";
      for (const line of wrapTextWithAnsi(capabilities, inner)) {
        lines.push(panelRow(`  ${dim(line)}`, panelWidth, yellow));
      }
    }
    lines.push(
      panelRow(
        ` ${dim("only approve projects you trust; extensions run with your permissions")}`,
        panelWidth,
        yellow,
      ),
    );
    const choices = [
      { label: "[y] Approve", color: cyan, active: this.selected === 0 },
      { label: "[n] Deny", color: red, active: this.selected === 1 },
    ]
      .map((choice) =>
        choice.active
          ? `\x1b[7m${choice.color(choice.label)}\x1b[0m`
          : choice.color(choice.label),
      )
      .join("   ");
    lines.push(panelRow(` ${choices}`, panelWidth, yellow));
    lines.push(
      panelRow(
        ` ${dim("←/→ select · Enter confirm · Esc deny")}`,
        panelWidth,
        yellow,
      ),
    );
    lines.push(panelBottom(panelWidth, yellow));
    return lines;
  }

  private finish(decision: ProjectTrustDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.onDecision(decision);
  }
}
