import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareCommandName,
  CommandRegistry,
  createCommandRegistry,
  parseCommandInput,
  type CommandContext,
} from "../../dist/cli/commands.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const AGENTS = [
  {
    name: "default",
    description: "general coding agent",
    mode: "primary" as const,
    active: true,
  },
  {
    name: "reviewer",
    description: "review code",
    mode: "primary" as const,
  },
  {
    name: "helper",
    description: "internal helper",
    mode: "subagent" as const,
  },
];

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

/** Temp git repo with one committed file, `a.txt` containing "a\n". */
function gitRepoWithInit(): string {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function fakeContext() {
  const lines: string[] = [];
  const calls: string[] = [];
  const ctx: CommandContext = {
    session: { id: "s1", workspace: "/w", provider: "fake", messages: [] },
    runtime: {},
    approvals: { mode: "ask", isTrusted: () => false },
    appendLine: (text) => lines.push(text),
    clearContent: () => calls.push("clear"),
    newSession: () => calls.push("new-session"),
    updateStatus: () => calls.push("status"),
    runDoctor: async () => "ok",
    runMcp: async () => {},
    runCompact: async () => {},
    runExport: async () => {},
    openModelPicker: () => calls.push("model-picker"),
    openProviderPicker: () => calls.push("provider-picker"),
    openEffortPicker: () => calls.push("effort-picker"),
    openThemePicker: () => calls.push("theme-picker"),
    openAgentPicker: () => calls.push("agent-picker"),
    openSessionsPicker: (scope) => calls.push(`sessions:${scope}`),
    searchSessions: (query) => calls.push(`search:${query}`),
    renameSession: (title) => calls.push(`rename:${title}`),
    listExtensions: () => "extensions",
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
    listAgents: () => AGENTS,
    activateAgent: (name) => calls.push(`agent:${name}`),
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
    "rename",
    "sessions",
    "search",
    "compact",
    "new",
    "approval",
    "doctor",
    "thinking",
    "theme",
    "agents",
    "agent",
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

test("/agents lists primary agents and marks the active one", async () => {
  const registry = createCommandRegistry();
  const { ctx, lines } = fakeContext();

  await registry.dispatch("/agents", ctx);

  const output = lines.at(-1) ?? "";
  assert.match(output, /^Agents:/);
  assert.match(output, /\* default\s+general coding agent/);
  assert.match(output, /  reviewer\s+review code/);
  assert.ok(!output.includes("helper"));
});

test("/agent switches to a primary agent and rejects bad names", async () => {
  const registry = createCommandRegistry();
  const { ctx, calls, lines } = fakeContext();

  await registry.dispatch("/agent reviewer", ctx);
  await registry.dispatch("/agent nope", ctx);
  await registry.dispatch("/agent helper", ctx);
  await registry.dispatch("/agent", ctx);

  assert.deepEqual(calls, ["agent:reviewer", "agent-picker"]);
  assert.match(
    lines[0] ?? "",
    /unknown agent: nope \(available: default, reviewer\)/,
  );
  assert.match(lines[1] ?? "", /agent helper is not a primary agent/);
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

test("session commands open pickers, search, and rename", async () => {
  const registry = createCommandRegistry();
  const { ctx, calls, lines } = fakeContext();

  await registry.dispatch("/sessions", ctx);
  await registry.dispatch("/sessions all", ctx);
  await registry.dispatch("/search login bug", ctx);
  await registry.dispatch("/rename rename Release checklist", ctx);
  await registry.dispatch("/rename", ctx);

  assert.deepEqual(calls, [
    "sessions:workspace",
    "sessions:all",
    "search:login bug",
    "rename:Release checklist",
  ]);
  assert.match(lines.at(-1) ?? "", /session: s1/);
  assert.match(lines.at(-1) ?? "", /messages: 0/);
});

test("empty session searches and renames explain their usage", async () => {
  const registry = createCommandRegistry();
  const { ctx, calls, lines } = fakeContext();

  await registry.dispatch("/search", ctx);
  await registry.dispatch("/rename rename", ctx);

  assert.deepEqual(calls, []);
  assert.deepEqual(lines, [
    "usage: /search <query>",
    "usage: /rename rename <title>",
  ]);
});

test("/undo no longer exists in the registry", () => {
  const registry = createCommandRegistry({ skills: SKILLS });
  assert.equal(registry.get("undo"), undefined);
  const names = registry.list().map((command) => command.name);
  assert.ok(!names.includes("undo"), "/undo should be removed");
});

test("/diff shows working-tree changes against git HEAD", async () => {
  const dir = gitRepoWithInit();
  writeFileSync(join(dir, "a.txt"), "changed\n");
  const { ctx, lines } = fakeContext();
  (ctx.session as any).workspace = dir;
  const registry = createCommandRegistry();
  await registry.dispatch("/diff", ctx);
  const output = lines.join("\n");
  assert.match(output, /a\.txt/);
  assert.match(output, /\+changed/);
});

test("/diff --stat summarizes changes against git HEAD", async () => {
  const dir = gitRepoWithInit();
  writeFileSync(join(dir, "a.txt"), "changed\n");
  const { ctx, lines } = fakeContext();
  (ctx.session as any).workspace = dir;
  const registry = createCommandRegistry();
  await registry.dispatch("/diff --stat", ctx);
  const output = lines.join("\n");
  assert.match(output, /1 file changed/);
  assert.match(output, /a\.txt/);
});

test("/diff filters by path argument", async () => {
  const dir = gitRepoWithInit();
  writeFileSync(join(dir, "a.txt"), "changed\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const { ctx, lines } = fakeContext();
  (ctx.session as any).workspace = dir;
  const registry = createCommandRegistry();
  await registry.dispatch("/diff b.txt", ctx);
  const output = lines.join("\n");
  assert.ok(!output.includes("a.txt"), "unrelated file should be filtered out");
  assert.match(output, /b\.txt/);
});

test("/diff reports no changes when the tree is clean", async () => {
  const dir = gitRepoWithInit();
  const { ctx, lines } = fakeContext();
  (ctx.session as any).workspace = dir;
  const registry = createCommandRegistry();
  await registry.dispatch("/diff", ctx);
  assert.ok(lines.some((l) => l.includes("(no changes)")));
});

test("/diff is unavailable outside a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const { ctx, lines } = fakeContext();
  (ctx.session as any).workspace = dir;
  const registry = createCommandRegistry();
  await registry.dispatch("/diff", ctx);
  assert.ok(
    lines.some((l) => l.includes("diff unavailable: not a git repository")),
  );
});
