import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todoTool } from "../../dist/tools/todo.js";
import { TodoStore } from "../../dist/runtime/todos.js";

const dir = mkdtempSync(join(tmpdir(), "todo-actions-"));
const signal = new AbortController().signal;

function ctx(store: TodoStore) {
  return { workspace: dir, signal, todos: store };
}

async function run(store: TodoStore, arguments_: Record<string, unknown>) {
  return todoTool.execute(
    { id: "c1", name: "todo", arguments: arguments_ as any },
    ctx(store),
  );
}

test("add appends one item without touching the rest of the list", async () => {
  const store = new TodoStore();
  store.add({ id: "KEEP", content: "keep me" });
  const result = await run(store, { action: "add", content: "new item" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    store.list().map((item) => item.id),
    ["KEEP", "T1"],
  );
  assert.equal(store.list()[0].content, "keep me");
  assert.equal(store.list()[1].content, "new item");
});

test("complete sets only the named item to completed", async () => {
  const store = new TodoStore();
  store.add({ id: "A", content: "a" });
  store.add({ id: "B", content: "b" });
  const result = await run(store, {
    action: "complete",
    id: "A",
    verification: "CI green",
  });
  assert.equal(result.isError, undefined);
  assert.equal(store.list()[0].status, "completed");
  assert.equal(store.list()[0].verification, "CI green");
  assert.equal(store.list()[1].status, "pending");
});

test("remove deletes only the named item", async () => {
  const store = new TodoStore();
  store.add({ id: "A", content: "a" });
  store.add({ id: "B", content: "b" });
  const result = await run(store, { action: "remove", id: "A" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    store.list().map((item) => item.id),
    ["B"],
  );
});

test("clear empties the list in one action", async () => {
  const store = new TodoStore();
  store.add({ content: "a" });
  store.add({ content: "b" });
  const result = await run(store, { action: "clear" });
  assert.equal(result.isError, undefined);
  assert.equal(store.openCount(), 0);
  assert.deepEqual(store.list(), []);
});

test("invalid actions, missing ids, and unknown ids return model-visible errors", async () => {
  const store = new TodoStore();
  store.add({ id: "A", content: "a" });
  assert.match(
    (await run(store, { action: "bogus" })).content,
    /TOOL_ARGUMENT_INVALID/,
  );
  assert.match(
    (await run(store, { action: "complete" })).content,
    /TODO_ID_REQUIRED/,
  );
  assert.match(
    (await run(store, { action: "remove", id: "missing" })).content,
    /TODO_NOT_FOUND/,
  );
  assert.match(
    (await run(store, { action: "add" })).content,
    /TOOL_ARGUMENT_INVALID|TODO_CONTENT_REQUIRED/,
  );
});

test("identifiers stay stable across edits and JSON round trips", () => {
  const store = new TodoStore();
  store.add({ id: "STABLE", content: "original" });
  store.update("STABLE", { content: "edited" });
  const restored = TodoStore.fromJSON(
    JSON.parse(JSON.stringify(store.toJSON())),
  );
  assert.equal(restored.list()[0].id, "STABLE");
  assert.equal(restored.list()[0].content, "edited");
});
