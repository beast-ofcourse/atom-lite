// Contract: the durable goal store keeps user-owned fields isolated, transitions
// status explicitly, and its completion gate names unmet criteria.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore, checkGoalCompletion } from "../../dist/runtime/goal.js";

test("goal store keeps statement, criteria, status, and constraints", () => {
  const store = new GoalStore();
  store.set("Ship the feature");
  store.setCriteria(["tests pass", "docs updated"]);
  store.setConstraints("no new dependencies");
  const goal = store.get();
  assert.equal(goal?.statement, "Ship the feature");
  assert.deepEqual(goal?.criteria, ["tests pass", "docs updated"]);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.constraints, "no new dependencies");
});

test("mutating returned state does not corrupt the store", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass"]);
  const goal = store.get()!;
  goal.statement = "changed";
  goal.criteria.push("added");
  assert.equal(store.get()?.statement, "Ship it");
  assert.deepEqual(store.get()?.criteria, ["tests pass"]);
});

test("pause, resume, complete, and clear are distinct transitions", () => {
  const store = new GoalStore();
  assert.equal(store.pause(), null);
  store.set("Ship it");
  assert.equal(store.pause()?.status, "paused");
  assert.equal(store.resume()?.status, "active");
  assert.equal(store.complete()?.status, "complete");
  store.clear();
  assert.equal(store.get(), null);
});

test("criteria from multiline text are split and deduplicated", () => {
  const store = new GoalStore();
  store.setCriteria(["tests pass\n docs updated", "tests pass"]);
  assert.deepEqual(store.get()?.criteria, ["tests pass", "docs updated"]);
});

test("goal survives a serialize and restore round trip", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass"]);
  store.pause();
  const restored = GoalStore.fromJSON(
    JSON.parse(JSON.stringify(store.toJSON())),
  );
  assert.equal(restored.get()?.statement, "Ship it");
  assert.deepEqual(restored.get()?.criteria, ["tests pass"]);
  assert.equal(restored.status, "paused");
});

test("completion gate names criteria with no todo or evidence", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass", "docs updated"]);
  const check = checkGoalCompletion(store.get()!, [], "");
  assert.equal(check.complete, false);
  assert.deepEqual(check.unmet, ["tests pass", "docs updated"]);
});

test("completed todos satisfy criteria", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass"]);
  const check = checkGoalCompletion(store.get()!, [
    {
      id: "T1",
      content: "run the test suite",
      status: "completed",
      verification: "tests pass",
    },
  ]);
  assert.equal(check.complete, true);
  assert.deepEqual(check.unmet, []);
});

test("a loosely related todo does not satisfy a criterion", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass"]);
  const check = checkGoalCompletion(store.get()!, [
    {
      id: "T1",
      content: "investigate why tests pass intermittently",
      status: "completed",
    },
  ]);
  assert.equal(check.complete, false);
  assert.deepEqual(check.unmet, ["tests pass"]);
});

test("explicit evidence satisfies remaining criteria", () => {
  const store = new GoalStore();
  store.set("Ship it");
  store.setCriteria(["tests pass", "docs updated"]);
  const check = checkGoalCompletion(store.get()!, [], "docs updated in README");
  assert.equal(check.complete, false);
  assert.deepEqual(check.unmet, ["tests pass"]);
  const full = checkGoalCompletion(
    store.get()!,
    [],
    "tests pass and docs updated",
  );
  assert.equal(full.complete, true);
});

test("a goal with no criteria needs no evidence", () => {
  const store = new GoalStore();
  store.set("Say hello");
  const check = checkGoalCompletion(store.get()!, [], "");
  assert.equal(check.complete, true);
});
