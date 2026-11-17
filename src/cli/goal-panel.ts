import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { darkTheme, type Theme } from "./theme.js";
import { panelBottom, panelRow, panelTop, type Color } from "./panel.js";
import { criterionSatisfied, type GoalState } from "../runtime/goal.js";
import type { TodoItem } from "../runtime/todos.js";

const RESET = "\x1b[0m";
const DARK_BG = "\x1b[48;5;236m";
const LIGHT_BG = "\x1b[48;5;252m";

/**
 * Fill the panel's allocated columns with a theme background. No-colour stays
 * completely plain. Style resets inside a row are followed by a fresh fill so
 * coloured status or border text cannot punch a hole in the sidebar.
 */
function backgroundFill(theme: Theme): (row: string) => string {
  if (theme.mode === "ansi") return (row) => row;
  const bg =
    theme.mode === "light" || theme.mode === "solarized" ? LIGHT_BG : DARK_BG;
  return (row) => `${bg}${row.replaceAll(RESET, `${RESET}${bg}`)}${RESET}`;
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Side panel showing the durable goal and its live task ledger. */
export class GoalPanel implements Component {
  private goal: GoalState | null = null;
  private todos: TodoItem[] = [];
  private theme: Theme = darkTheme;
  private userVisible = true;
  private cachedWidth = -1;
  private cachedRows: string[] = [];

  constructor(theme: Theme = darkTheme) {
    this.theme = theme;
  }

  setState(goal: GoalState | null, todos: TodoItem[]): void {
    this.goal = goal;
    this.todos = todos.map((todo) => ({ ...todo }));
    this.invalidate();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.invalidate();
  }

  /** Toggle user visibility; hidden state never discards goal or ledger data. */
  toggle(): boolean {
    this.userVisible = !this.userVisible;
    this.invalidate();
    return this.isVisible;
  }

  get isVisible(): boolean {
    return this.userVisible && (this.goal !== null || this.todos.length > 0);
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedRows = [];
  }

  render(width: number): string[] {
    if (!this.isVisible) return [];
    const w = Math.max(8, Math.floor(width));
    if (this.cachedWidth === w) return this.cachedRows;

    const tokens = this.theme.tokens;
    const border: Color = tokens.border;
    const inner = Math.max(1, w - 2);
    const rows: string[] = [panelTop("Goal", w, border)];
    const push = (text: string): void => {
      for (const line of wrap(text, inner)) {
        rows.push(panelRow(line, w, border));
      }
    };

    if (this.goal) {
      const statusStyle =
        this.goal.status === "paused"
          ? tokens.warning
          : this.goal.status === "complete"
            ? tokens.success
            : tokens.accent;
      push(`Statement: ${this.goal.statement}`);
      rows.push(
        panelRow(statusStyle(`Status: ${this.goal.status}`), w, border),
      );
      if (this.goal.criteria.length) {
        push("Success criteria:");
        for (const criterion of this.goal.criteria) {
          const mark =
            this.goal?.status === "complete" ||
            criterionSatisfied(criterion, this.todos)
              ? "x"
              : " ";
          push(`  [${mark}] ${criterion}`);
        }
      }
      if (this.goal.constraints) {
        push(`Constraints: ${this.goal.constraints}`);
      }
    }

    if (this.todos.length) {
      push("Todos:");
      for (const todo of this.todos) {
        const mark =
          todo.status === "completed"
            ? "x"
            : todo.status === "cancelled"
              ? "-"
              : " ";
        push(`  [${mark}] ${todo.id}: ${todo.content}`);
      }
    }

    rows.push(panelBottom(w, border));
    this.cachedWidth = w;
    const fill = backgroundFill(this.theme);
    this.cachedRows = rows.map((row) => fill(truncateToWidth(row, w, "…")));
    return this.cachedRows;
  }
}
