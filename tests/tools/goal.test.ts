import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalTool } from "../../dist/tools/goal.js";
import { GoalStore } from "../../dist/runtime/goal.js";
import { TodoStore } from "../../dist/runtime/todos.js";

const dir = mkdtempSync(join(tmpdir(), "goal-tool-"));
const signal = new AbortController().signal;

function ctx(goal: GoalStore | undefined, todos?: TodoStore) {
  return { workspace: dir, signal, goal, todos };
}

async function run(
  goal: GoalStore | undefined,
  arguments_: Record<string, unknown>,
  todos?: TodoStore,
) {
  return goalTool.execute(
    { id: "g1", name: "goal", arguments: arguments_ as any },
    ctx(goal, todos),
  );
}

function goalWithCriteria(): GoalStore {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass", "docs updated"]);
  store.setConstraints("no new dependencies");
  return store;
}

test("read returns statement, criteria, status, and constraints", async () => {
  const result = await run(goalWithCriteria(), { action: "read" });
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content);
  assert.equal(body.goal.statement, "Ship it");
  assert.deepEqual(body.goal.criteria, ["tests pass", "docs updated"]);
  assert.equal(body.goal.status, "active");
  assert.equal(body.goal.constraints, "no new dependencies");
});

test("complete succeeds when completed todos satisfy every criterion", async () => {
  const goal = goalWithCriteria();
  const todos = new TodoStore();
  todos.add({ content: "tests pass", status: "completed" });
  todos.add({ content: "docs updated", status: "completed" });
  const result = await run(goal, { action: "complete" }, todos);
  assert.equal(result.isError, undefined);
  const body = JSON.parse(result.content);
  assert.equal(body.completed, true);
  assert.equal(body.goal.status, "complete");
});

test("complete succeeds when evidence covers remaining criteria", async () => {
  const goal = goalWithCriteria();
  const todos = new TodoStore();
  todos.add({ content: "tests pass", status: "completed" });
  const result = await run(
    goal,
    {
      action: "complete",
      evidence: "README updated so docs updated",
    },
    todos,
  );
  assert.equal(result.isError, undefined);
  assert.equal(goal.status, "complete");
});

test("complete fails with the unmet criteria named and leaves the goal active", async () => {
  const goal = goalWithCriteria();
  const result = await run(goal, { action: "complete", evidence: "" });
  assert.equal(result.isError, true);
  assert.match(result.content, /GOAL_CRITERIA_UNMET/);
  assert.match(result.content, /tests pass/);
  assert.match(result.content, /docs updated/);
  assert.equal(goal.status, "active");
});

test("an unavailable or unset goal is reported", async () => {
  assert.match(
    (await run(undefined, { action: "read" })).content,
    /GOAL_STORE_UNAVAILABLE/,
  );
  assert.match(
    (await run(new GoalStore(), { action: "read" })).content,
    /GOAL_NOT_SET/,
  );
});

test("the tool exposes no mutating action for statement or criteria", async () => {
  const goal = goalWithCriteria();
  const result = await run(goal, { action: "set", statement: "hijacked" });
  assert.equal(result.isError, true);
  assert.match(result.content, /TOOL_ARGUMENT_INVALID/);
  assert.equal(goal.get()?.statement, "Ship it");
});

test("the tool works without a todo store", async () => {
  const goal = goalWithCriteria();
  const result = await run(goal, {
    action: "complete",
    evidence: "tests pass and docs updated",
  });
  assert.equal(result.isError, undefined);
  assert.equal(goal.status, "complete");
});
