import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todoTool } from "../../dist/tools/todo.js";
import { TodoStore } from "../../dist/runtime/todos.js";

function ctx(workspace: string, store = new TodoStore()) {
  return { workspace, signal: new AbortController().signal, todos: store };
}

test("todo read on an empty ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await todoTool.execute(
    { id: "1", name: "todo", arguments: { action: "read" } },
    ctx(dir),
  );
  assert.equal(r.isError, undefined);
  const body = JSON.parse(r.content);
  assert.equal(body.open, 0);
  assert.deepEqual(body.todos, []);
});

test("todo write creates items with auto ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const store = new TodoStore();
  const c = ctx(dir, store);
  const r = await todoTool.execute(
    {
      id: "1",
      name: "todo",
      arguments: {
        action: "write",
        todos: [
          { content: "task A", status: "pending" },
          { content: "task B", status: "completed", verification: "tests pass" },
        ],
      },
    },
    c,
  );
  assert.equal(r.isError, undefined);
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].id, "T1");
  assert.equal(store.list()[1].status, "completed");
  assert.equal(store.openCount(), 1);
});

test("todo update changes status and content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const store = new TodoStore();
  store.add({ content: "task A", status: "pending" });
  const c = ctx(dir, store);
  const r = await todoTool.execute(
    {
      id: "2",
      name: "todo",
      arguments: { action: "update", id: "T1", status: "completed", verification: "ok" },
    },
    c,
  );
  assert.equal(r.isError, undefined);
  assert.equal(store.list()[0].status, "completed");
  assert.equal(store.list()[0].verification, "ok");
  assert.equal(store.openCount(), 0);
});

test("todo update on a missing id fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await todoTool.execute(
    { id: "1", name: "todo", arguments: { action: "update", id: "nope", status: "completed" } },
    ctx(dir),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /TODO_NOT_FOUND/);
});

test("todo without a store is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await todoTool.execute(
    { id: "1", name: "todo", arguments: { action: "read" } },
    { workspace: dir, signal: new AbortController().signal },
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /TODO_STORE_UNAVAILABLE/);
});
