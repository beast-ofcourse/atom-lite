// Reason: the task-ledger panel seeds from durable history and live runtime
// events; these helpers keep both shapes consistent and reject bad payloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTodos,
  todoCounts,
  todoStatusLabel,
  todosFromHistory,
} from "../../web/todos.js";

test("normalizeTodos keeps known statuses and drops empty rows", () => {
  const todos = normalizeTodos([
    {
      id: "T1",
      content: "  ship   the panel ",
      status: "in_progress",
      verification: " tests ",
    },
    { content: "no id", status: "bogus" },
    { content: "   " },
    null,
    { content: "done one", status: "completed" },
    { content: "gone", status: "cancelled" },
  ]);
  assert.deepEqual(todos, [
    {
      id: "T1",
      content: "ship the panel",
      status: "in_progress",
      verification: "tests",
    },
    { id: "T2", content: "no id", status: "pending", verification: "" },
    {
      id: "T3",
      content: "done one",
      status: "completed",
      verification: "",
    },
    { id: "T4", content: "gone", status: "cancelled", verification: "" },
  ]);
});

test("todoCounts counts open work across statuses", () => {
  const counts = todoCounts([
    { status: "pending" },
    { status: "in_progress" },
    { status: "completed" },
    { status: "cancelled" },
    { status: "unknown" },
  ]);
  assert.equal(counts.total, 5);
  assert.equal(counts.open, 3);
  assert.equal(counts.pending, 2);
  assert.equal(counts.in_progress, 1);
  assert.equal(counts.completed, 1);
  assert.equal(counts.cancelled, 1);
});

test("todosFromHistory uses the latest durable ledger", () => {
  const events = [
    { type: "todos_updated", todos: [{ id: "T1", content: "old" }] },
    { type: "assistant_message", message: {} },
    {
      type: "todos_updated",
      todos: [{ id: "T2", content: "new", status: "completed" }],
    },
  ];
  assert.deepEqual(todosFromHistory(events), [
    {
      id: "T2",
      content: "new",
      status: "completed",
      verification: "",
    },
  ]);
  assert.deepEqual(todosFromHistory(undefined), []);
  assert.deepEqual(todosFromHistory([{ type: "todos_updated" }]), []);
});

test("todoStatusLabel names every state", () => {
  assert.equal(todoStatusLabel("pending"), "Pending");
  assert.equal(todoStatusLabel("in_progress"), "In progress");
  assert.equal(todoStatusLabel("completed"), "Done");
  assert.equal(todoStatusLabel("cancelled"), "Cancelled");
});
