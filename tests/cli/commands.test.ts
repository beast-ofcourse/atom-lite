import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareCommandName,
  CommandRegistry,
  createCommandRegistry,
  parseCommandInput,
  type CommandContext,
} from "../../dist/cli/commands.js";

const SKILLS = [
  {
    name: "review",
    description: "review code",
    path: "/tmp/review/SKILL.md",
    scope: "global" as const,
  },
  {
    name: "triage",
    description: "sort issues",
    path: "/tmp/triage/SKILL.md",
    scope: "global" as const,
  },
];

function fakeContext() {
  const lines: string[] = [];
  const calls: string[] = [];
  const ctx: CommandContext = {
    session: { id: "s1", workspace: "/w", provider: "fake", messages: [] },
    runtime: {},
    approvals: { mode: "ask", isTrusted: () => false },
    appendLine: (text) => lines.push(text),
    clearContent: () => calls.push("clear"),
    updateStatus: () => calls.push("status"),
    runDoctor: async () => "ok",
    openModelPicker: () => calls.push("model-picker"),
    openProviderPicker: () => calls.push("provider-picker"),
    openEffortPicker: () => calls.push("effort-picker"),
    openThemePicker: () => calls.push("theme-picker"),
    switchModel: (target) => calls.push(`model:${target}`),
    startProviderSetup: (profile) => calls.push(`provider:${profile}`),
    setEffort: (level) => calls.push(`effort:${level}`),
    toggleThinking: () => true,
    setTheme: (name) => calls.push(`theme:${name}`),
    listSkills: () =>
      SKILLS.map(({ name, description }) => ({ name, description })),
    loadSkill: async (name, extra) => {
      calls.push(`skill:${name}${extra ? `:${extra}` : ""}`);
      return true;
    },
    runTurn: async (prompt) => calls.push(`turn:${prompt}`),
    requestExit: () => calls.push("exit"),
  };
  return { ctx, lines, calls };
}

test("parseCommandInput splits command names and arguments", () => {
  assert.deepEqual(parseCommandInput("/theme dark"), {
    name: "theme",
    args: "dark",
    raw: "/theme dark",
  });
  assert.equal(parseCommandInput("hello"), null);
});

test("registry lists every built-in command plus skills", () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  const names = registry.list().map((command) => command.name);
  for (const name of [
    "help",
    "model",
    "provider",
    "effort",
    "session",
    "compact",
    "clear",
    "approval",
    "doctor",
    "thinking",
    "theme",
    "skills",
    "skill",
    "exit",
    "review",
    "triage",
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.equal(registry.get("quit")?.name, "exit");
});

test("help output is grouped by category and derived from the registry", () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  const help = registry.helpText();
  assert.match(help, /^Commands:/);
  assert.match(help, /Model/);
  assert.match(help, /Appearance/);
  assert.match(help, /\/theme \[auto\|dark\|light\|ansi\]/);
  assert.match(help, /Skills/);
  assert.match(help, /\/review \[prompt\]\s+review code/);
});

test("autocomplete is generated from the same registry", () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  const autocomplete = registry.autocomplete();
  assert.deepEqual(
    autocomplete.map((entry) => entry.name),
    registry.list().map((command) => command.name),
  );
  const theme = autocomplete.find((entry) => entry.name === "theme");
  assert.equal(theme?.argumentHint, "[auto|dark|light|ansi]");
});

test("dispatch runs the matching handler with arguments", async () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  const { ctx, calls } = fakeContext();

  await registry.dispatch("/theme dark", ctx);
  await registry.dispatch("/theme", ctx);
  await registry.dispatch("/effort high", ctx);
  await registry.dispatch("/model gpt", ctx);

  assert.deepEqual(calls, [
    "theme:dark",
    "theme-picker",
    "effort:high",
    "model:gpt",
  ]);
});

test("skills dispatch through the registry with no separate handler", async () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  const { ctx, calls } = fakeContext();

  await registry.dispatch("/review please look", ctx);
  await registry.dispatch("/skill triage now", ctx);

  assert.deepEqual(calls, ["skill:review:please look", "skill:triage:now"]);
});

test("bare skill names still route through the registry, but other prompts do not", () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  assert.equal(bareCommandName(registry, "review please look"), "review");
  assert.equal(bareCommandName(registry, "/review please look"), undefined);
  assert.equal(bareCommandName(registry, "fix the bug"), undefined);
  assert.equal(bareCommandName(registry, "help"), undefined);
});

test("unknown commands are consumed with a clear message", async () => {
  const registry = new CommandRegistry();
  const { ctx, lines } = fakeContext();

  const result = await registry.dispatch("/nope", ctx);

  assert.equal(result.handled, true);
  assert.equal(result.unknown, true);
  assert.match(lines[0], /unknown command: \/nope/);
});

test("plain prompts are not treated as commands", async () => {
  const registry = createCommandRegistry();
  const { ctx } = fakeContext();
  const result = await registry.dispatch("fix the bug", ctx);
  assert.equal(result.handled, false);
});

test("exit aliases request shutdown", async () => {
  const registry = createCommandRegistry();
  const { ctx, calls } = fakeContext();
  const result = await registry.dispatch("/quit", ctx);
  assert.equal(result.exit, true);
  assert.deepEqual(calls, ["exit"]);
});
