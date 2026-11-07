export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  /** Optional evidence the task is done (command, test, or review note). */
  verification?: string;
}

export interface TodoInput {
  id?: string;
  content: string;
  status?: TodoStatus;
  verification?: string;
}

const STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function normalizeStatus(value: unknown): TodoStatus {
  return typeof value === "string" && STATUSES.has(value as TodoStatus)
    ? (value as TodoStatus)
    : "pending";
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Session task ledger. It is intentionally independent of the message
 * history: compaction can drop old messages, but open tasks stay visible.
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  constructor(items?: TodoInput[]) {
    if (items) this.replace(items);
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  replace(inputs: TodoInput[]): TodoItem[] {
    this.items = [];
    this.nextId = 1;
    for (const input of inputs) {
      const content = normalizeContent(input.content ?? "");
      if (!content) continue;
      const id = input.id?.trim() || `T${this.nextId++}`;
      this.bumpNextId(id);
      this.items.push({
        id,
        content,
        status: normalizeStatus(input.status),
        ...(input.verification
          ? { verification: String(input.verification).trim() }
          : {}),
      });
    }
    return this.list();
  }

  add(input: TodoInput): TodoItem {
    const content = normalizeContent(input.content ?? "");
    if (!content) throw new Error("TODO_CONTENT_REQUIRED");
    const id = input.id?.trim() || `T${this.nextId++}`;
    this.bumpNextId(id);
    const item: TodoItem = {
      id,
      content,
      status: normalizeStatus(input.status),
      ...(input.verification
        ? { verification: String(input.verification).trim() }
        : {}),
    };
    this.items.push(item);
    return { ...item };
  }

  update(
    id: string,
    patch: Partial<Omit<TodoItem, "id">>,
  ): TodoItem | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    if (patch.content !== undefined) {
      const content = normalizeContent(patch.content);
      if (content) item.content = content;
    }
    if (patch.status !== undefined) item.status = normalizeStatus(patch.status);
    if (patch.verification !== undefined) {
      const verification = String(patch.verification).trim();
      if (verification) item.verification = verification;
      else delete item.verification;
    }
    return { ...item };
  }

  contains(content: string): boolean {
    const needle = normalizeContent(content).slice(0, 80).toLowerCase();
    if (!needle) return false;
    return this.items.some(
      (item) =>
        normalizeContent(item.content).slice(0, 80).toLowerCase() === needle,
    );
  }

  openCount(): number {
    return this.items.filter(
      (item) => item.status === "pending" || item.status === "in_progress",
    ).length;
  }

  counts(): Record<TodoStatus, number> {
    const counts: Record<TodoStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const item of this.items) counts[item.status] += 1;
    return counts;
  }

  renderForPrompt(options?: { completionCheck?: boolean }): string | null {
    if (this.items.length === 0) return null;
    const counts = this.counts();
    const open = counts.pending + counts.in_progress;
    const lines = [
      "## Task ledger",
      `Open: ${open} | Completed: ${counts.completed} | Cancelled: ${counts.cancelled}`,
      ...this.items.map((item) => {
        const verification = item.verification
          ? ` (verify: ${item.verification})`
          : "";
        return `- [${item.status}] ${item.id}: ${item.content}${verification}`;
      }),
      "Keep this ledger current with the todo tool. Mark a task completed only after its verification step passes. Do not claim the overall request is complete while any item is pending or in progress.",
    ];
    if (options?.completionCheck) {
      lines.push(
        "Completion check: open items remain. Continue working or update the ledger (completed/cancelled) before returning a final answer.",
      );
    }
    return lines.join("\n");
  }

  toJSON(): TodoItem[] {
    return this.list();
  }

  static fromJSON(value: unknown): TodoStore {
    const store = new TodoStore();
    if (!Array.isArray(value)) return store;
    const inputs: TodoInput[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const content =
        typeof record.content === "string" ? record.content : "";
      if (!content.trim()) continue;
      inputs.push({
        id: typeof record.id === "string" ? record.id : undefined,
        content,
        status: normalizeStatus(record.status),
        verification:
          typeof record.verification === "string"
            ? record.verification
            : undefined,
      });
    }
    store.replace(inputs);
    return store;
  }

  private bumpNextId(id: string): void {
    const match = /^T(\d+)$/.exec(id);
    if (!match) return;
    this.nextId = Math.max(this.nextId, Number(match[1]) + 1);
  }
}
