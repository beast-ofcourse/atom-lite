import type { TodoItem } from "./todos.js";

export const GOAL_STATUSES = ["active", "paused", "complete"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalState {
  /** Single-line, user-owned statement of the task. */
  statement: string;
  /** User-owned success criteria that define "done". */
  criteria: string[];
  status: GoalStatus;
  /** Optional user-owned constraints on how the task may be approached. */
  constraints?: string;
}

const STATUSES: ReadonlySet<GoalStatus> = new Set(GOAL_STATUSES);

function normalizeLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeStatus(value: unknown): GoalStatus {
  return typeof value === "string" && STATUSES.has(value as GoalStatus)
    ? (value as GoalStatus)
    : "active";
}

/**
 * Durable statement of what a long-running task is and what success means.
 *
 * The goal is session state, independent of message history. It is owned by
 * the user through the `/goal` command; the model may only read it and mark it
 * complete with evidence. Keeping it separate from the task ledger is
 * deliberate: an anchor that can be edited like an ordinary todo drifts.
 */
export class GoalStore {
  private state: GoalState | null = null;

  get(): GoalState | null {
    return this.state
      ? { ...this.state, criteria: [...this.state.criteria] }
      : null;
  }

  get status(): GoalStatus | null {
    return this.state?.status ?? null;
  }

  get isEmpty(): boolean {
    return this.state === null;
  }

  set(statement: string): GoalState {
    const next = normalizeLine(statement);
    this.state = {
      statement: next,
      criteria: this.state?.criteria ?? [],
      status: "active",
      ...(this.state?.constraints
        ? { constraints: this.state.constraints }
        : {}),
    };
    return this.get()!;
  }

  setCriteria(values: string[]): GoalState {
    const criteria = values
      .flatMap((value) => String(value).split(/\r?\n/))
      .map((value) => normalizeLine(value))
      .filter(
        (value, index, all) => value !== "" && all.indexOf(value) === index,
      );
    const base: GoalState = this.state
      ? { ...this.state, criteria: [...this.state.criteria] }
      : { statement: "", criteria: [], status: "active" };
    this.state = {
      statement: base.statement,
      criteria,
      status: base.status === "paused" ? "paused" : "active",
      ...(base.constraints ? { constraints: base.constraints } : {}),
    };
    return this.get()!;
  }

  setConstraints(value: string): GoalState {
    const constraints = normalizeLine(value);
    const base: GoalState = this.state
      ? { ...this.state, criteria: [...this.state.criteria] }
      : { statement: "", criteria: [], status: "active" };
    this.state = {
      statement: base.statement,
      criteria: base.criteria,
      status: base.status,
      ...(constraints ? { constraints } : {}),
    };
    return this.get()!;
  }

  pause(): GoalState | null {
    if (!this.state || this.state.status !== "active") return this.get();
    this.state = { ...this.state, status: "paused" };
    return this.get();
  }

  resume(): GoalState | null {
    if (!this.state || this.state.status !== "paused") return this.get();
    this.state = { ...this.state, status: "active" };
    return this.get();
  }

  complete(): GoalState | null {
    if (!this.state) return null;
    this.state = { ...this.state, status: "complete" };
    return this.get();
  }

  clear(): void {
    this.state = null;
  }

  replace(value: unknown): void {
    this.state = GoalStore.fromJSON(value).get();
  }

  renderForPrompt(): string | null {
    if (!this.state) return null;
    const lines = [
      "## Current goal",
      `Statement: ${this.state.statement}`,
      `Status: ${this.state.status}`,
      "Success criteria:",
      ...(this.state.criteria.length
        ? this.state.criteria.map((criterion) => `- ${criterion}`)
        : ["- (none declared)"]),
    ];
    if (this.state.constraints) {
      lines.push(`Constraints: ${this.state.constraints}`);
    }
    if (this.state.status === "paused") {
      lines.push(
        "The goal is paused: do not start new work until the user resumes it.",
      );
    }
    lines.push(
      "The statement, criteria, status, and constraints are user-owned. Do not rewrite them; use the goal tool to read the goal or to mark it complete with evidence.",
    );
    return lines.join("\n");
  }

  toJSON(): GoalState | null {
    return this.get();
  }

  static fromJSON(value: unknown): GoalStore {
    const store = new GoalStore();
    if (!value || typeof value !== "object") return store;
    const record = value as Record<string, unknown>;
    const statement = normalizeLine(record.statement);
    const criteria = Array.isArray(record.criteria) ? record.criteria : [];
    store.state = {
      statement,
      criteria: criteria.map((c) => normalizeLine(c)).filter((c) => c !== ""),
      status: normalizeStatus(record.status),
      ...(typeof record.constraints === "string" && record.constraints.trim()
        ? { constraints: normalizeLine(record.constraints) }
        : {}),
    };
    return store;
  }
}

export interface CompletionCheck {
  complete: boolean;
  /** Criteria with neither a completed todo nor supporting evidence. */
  unmet: string[];
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * One criterion is satisfied by a completed todo that names it (in content or
 * verification) or by explicit evidence that names it. Shared by the goal
 * tool's completion gate and the TUI panel's progress markers.
 */
export function criterionSatisfied(
  criterion: string,
  todos: TodoItem[],
  evidence?: string,
): boolean {
  const needle = normalized(criterion);
  if (!needle) return false;
  return (
    todos.some(
      (item) =>
        item.status === "completed" &&
        (normalized(item.content) === needle ||
          normalized(item.verification ?? "").includes(needle)),
    ) || normalized(evidence ?? "").includes(needle)
  );
}

/**
 * Soft completion gate. A criterion is satisfied when a completed todo
 * describes it, that todo's verification names it, or the caller supplies
 * explicit evidence that names it. The gate blocks the completion call, not
 * the run.
 */
export function checkGoalCompletion(
  goal: GoalState | null,
  todos: TodoItem[],
  evidence?: string,
): CompletionCheck {
  if (!goal) return { complete: false, unmet: [] };
  const unmet = goal.criteria.filter(
    (criterion) => !criterionSatisfied(criterion, todos, evidence),
  );
  return { complete: unmet.length === 0, unmet };
}
