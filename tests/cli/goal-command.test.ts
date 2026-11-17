// Contract: every /goal subcommand parses and dispatches through the command
// registry, and the completion branch uses the real criterion gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCommandRegistry,
  type CommandContext,
} from "../../dist/cli/commands.js";
import { GoalStore, checkGoalCompletion } from "../../dist/runtime/goal.js";
import { TodoStore } from "../../dist/runtime/todos.js";

function harness() {
  const lines: string[] = [];
  const calls: string[] = [];
  const goalStore = new GoalStore();
  const todoStore = new TodoStore();
  const session = { id: "s1", workspace: "/w", provider: "fake", messages: [] };
  const runtime = {
    getGoal: () => goalStore.get(),
    getTodos: () => todoStore.list(),
    setGoal: (statement: string) => goalStore.set(statement),
    setGoalCriteria: (criteria: string[]) => goalStore.setCriteria(criteria),
    setGoalConstraints: (value: string) => goalStore.setConstraints(value),
    pauseGoal: () => goalStore.pause(),
    resumeGoal: () => goalStore.resume(),
    clearGoal: () => goalStore.clear(),
    completeGoal: (evidence?: string) => {
      const state = goalStore.get();
      if (!state) return { ok: false, unmet: [] as string[], goal: null };
      const check = checkGoalCompletion(state, todoStore.list(), evidence);
      if (!check.complete)
        return { ok: false, unmet: check.unmet, goal: state };
      return { ok: true, unmet: [], goal: goalStore.complete() };
    },
  };
  const ctx: CommandContext = {
    session,
    runtime,
    approvals: { mode: "ask", isTrusted: () => false },
    appendLine: (text) => lines.push(text),
    clearContent: () => {},
    newSession: () => calls.push("new-session"),
    updateStatus: () => calls.push("status"),
    runDoctor: async () => "ok",
    runMcp: () => {},
    runCompact: () => {},
    runExport: () => {},
    openModelPicker: () => {},
    openProviderPicker: () => {},
    openKeybindings: () => {},
    shortcutsText: () => "",
    openEffortPicker: () => {},
    openThemePicker: () => {},
    openSessionsPicker: () => {},
    searchSessions: () => {},
    renameSession: () => {},
    listExtensions: () => "",
    extensionDoctor: () => "",
    reloadExtensions: async () => {},
    switchModel: () => {},
    startProviderSetup: () => {},
    setEffort: () => {},
    toggleThinking: () => true,
    setTheme: () => {},
    listSkills: () => [],
    loadSkill: async () => true,
    listAgents: () => [],
    activateAgent: () => {},
    openAgentPicker: () => {},
    runTurn: async (prompt) => calls.push(`turn:${prompt}`),
    setProjectTrust: () => {},
    requestExit: () => {},
  };
  return {
    registry: createCommandRegistry(),
    ctx,
    lines,
    calls,
    goalStore,
    todoStore,
  };
}

async function goal(args: string, h = harness()) {
  await h.registry.dispatch(`/goal ${args}`.trim(), h.ctx);
  return h;
}

test("goal command is registered in help and autocomplete", () => {
  const { registry } = harness();
  assert.ok(registry.list().some((command) => command.name === "goal"));
  assert.match(registry.helpText(), /\/goal/);
  assert.ok(registry.autocomplete().some((entry) => entry.name === "goal"));
});

test("goal set, criteria, and constraints update user-owned fields", async () => {
  const h = await goal("set Ship the feature");
  assert.match(h.lines[0], /goal set: Ship the feature/);
  assert.equal(h.goalStore.get()?.statement, "Ship the feature");

  await goal("criteria tests pass; docs updated", h);
  assert.deepEqual(h.goalStore.get()?.criteria, ["tests pass", "docs updated"]);

  await goal("constraints no new dependencies", h);
  assert.equal(h.goalStore.get()?.constraints, "no new dependencies");
});

test("bare invocation and status report statement, criteria, status, and todos", async () => {
  const h = await goal("set Ship the feature");
  await goal("criteria tests pass", h);
  const bare = await goal("", h);
  const output = bare.lines[bare.lines.length - 1];
  assert.match(output, /Goal: Ship the feature/);
  assert.match(output, /Status: active/);
  assert.match(output, /- tests pass/);
  assert.match(output, /Todos: 0 open of 0/);
});

test("pause, resume, and clear change runtime state", async () => {
  const h = await goal("set Ship it");
  await goal("pause", h);
  assert.equal(h.goalStore.status, "paused");
  await goal("resume", h);
  assert.equal(h.goalStore.status, "active");
  assert.ok(h.calls.includes("turn:continue"));
  await goal("clear", h);
  assert.equal(h.goalStore.get(), null);
});

test("resume does not start a new turn while one is active", async () => {
  const h = harness();
  h.ctx.isTurnActive = () => true;
  await goal("set Ship it", h);
  await goal("pause", h);
  await goal("resume", h);
  assert.ok(!h.calls.some((call) => call.startsWith("turn:")));
});

test("complete applies the criterion gate and names unmet criteria", async () => {
  const h = await goal("set Ship it");
  await goal("criteria tests pass; docs updated", h);
  const blocked = await goal("complete", h);
  const blockedLine = blocked.lines[blocked.lines.length - 1];
  assert.match(blockedLine, /unmet criteria/);
  assert.match(blockedLine, /tests pass/);
  assert.match(blockedLine, /docs updated/);
  assert.equal(h.goalStore.status, "active");

  const done = await goal("complete tests pass and docs updated", h);
  assert.equal(done.goalStore.status, "complete");
  assert.match(done.lines[done.lines.length - 1], /goal complete/);
});

test("unknown subcommands return usage", async () => {
  const h = await goal("bogus");
  assert.match(h.lines[0], /unknown goal subcommand: bogus/);
  assert.match(h.lines[1], /usage: \/goal/);
});
