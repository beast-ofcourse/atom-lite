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
  green,
  panelBottom,
  panelRow,
  panelTop,
  red,
  yellow,
} from "./panel.js";

export type ApprovalDecision = "approve" | "deny" | "trust-session";

export interface ApprovalRequestView {
  command: string;
  cwd: string;
  timeoutMs: number;
  sandboxed: boolean;
}

interface Choice {
  value: ApprovalDecision;
  key: string;
  label: string;
  color: (text: string) => string;
}

const CHOICES: Choice[] = [
  { value: "approve", key: "y", label: "Approve", color: green },
  { value: "deny", key: "n", label: "Deny", color: red },
  { value: "trust-session", key: "t", label: "Trust session", color: cyan },
];

/**
 * Modal approval prompt. It captures input directly (y / n / t, arrows + Enter,
 * Esc to deny) so the editor underneath cannot accidentally receive the
 * confirmation keys while a command is waiting.
 */
export class ApprovalPrompt implements Component {
  private selected = 1; // Default to the safe choice.
  private settled = false;

  constructor(
    private readonly request: ApprovalRequestView,
    private readonly onDecision: (decision: ApprovalDecision) => void,
  ) {}

  invalidate(): void {
    // No cached render state.
  }

  handleInput(data: string): void {
    if (this.settled || isKeyRelease(data)) return;

    if (matchesKey(data, "left")) {
      this.selected = (this.selected + CHOICES.length - 1) % CHOICES.length;
      return;
    }
    if (matchesKey(data, "right")) {
      this.selected = (this.selected + 1) % CHOICES.length;
      return;
    }

    const key = (
      decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined)
    )?.toLowerCase();
    if (key === "y") return this.finish("approve");
    if (key === "n") return this.finish("deny");
    if (key === "t") return this.finish("trust-session");
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      return this.finish(CHOICES[this.selected].value);
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      return this.finish("deny");
    }
  }

  render(width: number): string[] {
    const panelWidth = Math.max(8, Math.floor(width));
    const inner = panelWidth - 4;
    const lines: string[] = [
      panelTop("⚠ approval required", panelWidth, yellow),
    ];

    for (const line of wrapTextWithAnsi(this.request.command, inner)) {
      lines.push(panelRow(` ${line}`, panelWidth, yellow));
    }

    const meta = `${this.request.cwd} · ${Math.round(
      this.request.timeoutMs / 1000,
    )}s · ${this.request.sandboxed ? "sandboxed" : "not sandboxed"}`;
    for (const line of wrapTextWithAnsi(meta, inner)) {
      lines.push(panelRow(` ${dim(line)}`, panelWidth, yellow));
    }

    lines.push(panelRow("", panelWidth, yellow));
    const choices = CHOICES.map((choice, index) => {
      const text = `[${choice.key}] ${choice.label}`;
      return index === this.selected
        ? `\x1b[7m${choice.color(text)}\x1b[0m`
        : choice.color(text);
    }).join("   ");
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

  private finish(decision: ApprovalDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.onDecision(decision);
  }
}
