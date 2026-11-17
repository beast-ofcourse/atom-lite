/**
 * Pure helpers for the task-ledger panel.
 *
 * The runtime's TodoStore is the source of truth. The browser receives live
 * `ledger_state` / `task_ledger_open` events and durable `todos_updated`
 * session events; these helpers keep both shapes consistent for rendering.
 */

export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

const STATUS_SET = new Set(TODO_STATUSES);

function statusOf(value) {
  return typeof value === "string" && STATUS_SET.has(value) ? value : "pending";
}

function contentOf(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  const todos = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const content = contentOf(raw.content);
    if (!content) continue;
    const id =
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `T${todos.length + 1}`;
    todos.push({
      id,
      content,
      status: statusOf(raw.status),
      verification:
        typeof raw.verification === "string" ? raw.verification.trim() : "",
    });
  }
  return todos;
}

/** Latest durable ledger snapshot in a session event history. */
export function todosFromHistory(events) {
  let latest = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event && event.type === "todos_updated" && Array.isArray(event.todos)) {
      latest = event.todos;
    }
  }
  return normalizeTodos(latest);
}

export function todoCounts(todos) {
  const counts = {
    total: 0,
    open: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const todo of Array.isArray(todos) ? todos : []) {
    const status = statusOf(todo?.status);
    counts.total += 1;
    counts[status] += 1;
    if (status === "pending" || status === "in_progress") counts.open += 1;
  }
  return counts;
}

export function todoStatusLabel(status) {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending";
  }
}
