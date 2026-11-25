import type { SlashCommand } from "@earendil-works/pi-tui";
import type { Skill } from "../skills/registry.js";
import type { AgentPersona } from "../agents/registry.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One interactive command. The registry is the single source of truth for
 * dispatch, `/help`, autocomplete, and the command palette.
 */
export interface CommandDefinition {
  /** Command name without the leading slash. */
  name: string;
  aliases?: string[];
  description: string;
  category: string;
  argumentHint?: string;
  /** Allow invoking this command without the leading slash. */
  bareInvokable?: boolean;
  /** Exit the interactive loop after this command completes. */
  exits?: boolean;
  run(ctx: CommandContext, args: string, raw: string): void | Promise<void>;
}

export interface PromptTemplate {
  name: string;
  description: string;
  content: string;
  source: "user" | "project";
}

export type LoadedSkill = Pick<Skill, "name" | "description">;
export type LoadedAgent = Pick<
  AgentPersona,
  "name" | "description" | "mode"
> & {
  active?: boolean;
};

/**
 * Everything a command is allowed to do. The app supplies the real
 * implementation; tests supply a fake, so command behaviour stays free of TUI
 * imports.
 */
export interface CommandContext {
  session: any;
  runtime: any;
  approvals: any;
  appendLine(text: string): void;
  clearContent(): void;
  newSession(): void;
  updateStatus(): void;
  runDoctor(): Promise<string>;
  runMcp(args: string): Promise<void> | void;
  runCompact(args: string): Promise<void> | void;
  runExport(args: string): Promise<void> | void;
  openModelPicker(): void;
  openProviderPicker(): void;
  openKeybindings(): void;
  shortcutsText(): string;
  openEffortPicker(): void;
  openThinkingPicker(): void;
  openThemePicker(): void;
  openSessionsPicker(scope: "workspace" | "all"): void;
  showUsage(): void;
  searchSessions(query: string): void;
  renameSession(title: string): void;
  listExtensions(): string;
  extensionDoctor(): string;
  extensionDoctorJson(): string;
  reloadExtensions(): Promise<void>;
  switchModel(target: string): void;
  startProviderSetup(profile: string): void;
  setEffort(level: string): void;
  toggleThinking(): boolean;
  setTheme(name: string): void;
  listSkills(): LoadedSkill[];
  loadSkill(name: string, extra: string): Promise<boolean>;
  listAgents(): LoadedAgent[];
  activateAgent(name: string): void;
  openAgentPicker(): void;
  runTurn(prompt: string): Promise<void>;
  runUndo(): Promise<void> | void;
  runRedo(): Promise<void> | void;
  runBtw?(question: string): Promise<void> | void;
  /** True while the agent loop owns the turn; used by /goal resume. */
  isTurnActive?(): boolean;
  /** Manage project trust for extensions/agents. Takes effect on reload. */
  setProjectTrust(decision: "allow" | "deny" | "reset"): void;
  changeDirectory(dir: string): void;
  requestExit(): void;
}

/** Pi-style `$@` / `$ARGUMENTS` substitution for a prompt template body. */
export function expandPromptTemplate(content: string, args: string): string {
  return content.replace(/\$@|\$ARGUMENTS/g, () => args.trim());
}

/**
 * Load Pi-style markdown prompt templates from a user or project directory.
 * The filename becomes the command name. Project templates load only when the
 * workspace is trusted.
 */
export function discoverPromptTemplates(
  userDir: string,
  projectDirs: string[],
  projectTrusted: boolean,
): PromptTemplate[] {
  const templates = new Map<string, PromptTemplate>();
  const scan = (dir: string, source: "user" | "project") => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const filePath = join(dir, name);
      let text: string;
      try {
        if (!statSync(filePath).isFile()) continue;
        text = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const fenced = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const frontmatter = fenced?.[1] ?? "";
      const content = fenced ? text.slice(fenced[0].length) : text;
      const description =
        /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ||
        content
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ||
        name;
      templates.set(name.slice(0, -3), {
        name: name.slice(0, -3),
        description,
        content: content.trim(),
        source,
      });
    }
  };
  scan(userDir, "user");
  if (projectTrusted) {
    for (const dir of projectDirs) scan(dir, "project");
  }
  return [...templates.values()];
}

/** Expand `~` and `~/...` to absolute home paths; leave other paths unchanged. */
export function expandDirectoryPath(input: string): string {
  const target = input.trim();
  const home = homedir();
  if (target === "~") return home;
  if (target.startsWith("~/")) return join(home, target.slice(2));
  return target;
}

export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

export interface CommandDispatchResult {
  /** True when the input was consumed by the registry. */
  handled: boolean;
  /** True when the command requested shutdown. */
  exit?: boolean;
  /** True when the command name did not exist. */
  unknown?: boolean;
  name?: string;
  /** A contained command failure, surfaced on a user-visible line. */
  error?: string;
}

/** Run git in a workspace; throws on failure so callers can map it to a message. */
function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Parse `/name args` into its parts; non-slash input returns null. */
export function parseCommandInput(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] ?? "").trim(),
    raw: trimmed,
  };
}

/** Return the bare (slash-less) command name for inputs that opt in. */
export function bareCommandName(
  registry: CommandRegistry,
  input: string,
): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("/")) return undefined;
  const first = trimmed.split(/\s+/)[0];
  const command = registry.get(first);
  return command?.bareInvokable ? command.name : undefined;
}

export class CommandRegistry {
  private readonly ordered: CommandDefinition[] = [];
  private readonly byName = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    if (this.byName.has(definition.name)) return;
    this.ordered.push(definition);
    this.byName.set(definition.name, definition);
    for (const alias of definition.aliases ?? []) {
      if (!this.byName.has(alias)) this.byName.set(alias, definition);
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name);
  }

  list(): readonly CommandDefinition[] {
    return this.ordered;
  }

  /** `/help` grouped by category, with argument hints. */
  helpText(): string {
    const groups = new Map<string, CommandDefinition[]>();
    for (const command of this.ordered) {
      const list = groups.get(command.category) ?? [];
      list.push(command);
      groups.set(command.category, list);
    }
    const lines = ["Commands:"];
    for (const [category, commands] of groups) {
      lines.push(`  ${category}`);
      for (const command of commands) {
        const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
        const label = `    /${command.name}${hint}`;
        lines.push(
          label.length >= 30
            ? `${label} ${command.description}`
            : label.padEnd(30) + command.description,
        );
      }
    }
    return lines.join("\n");
  }

  /** Autocomplete entries derive from the same registry. */
  autocomplete(): SlashCommand[] {
    return this.ordered.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    }));
  }

  /**
   * Dispatch a slash command. Unknown commands consume the input and append a
   * clear message so they can never fall through to the agent as a prompt.
   */
  async dispatch(
    input: string,
    ctx: CommandContext,
  ): Promise<CommandDispatchResult> {
    const parsed = parseCommandInput(input);
    if (!parsed) return { handled: false };

    const command = this.get(parsed.name);
    if (!command) {
      ctx.appendLine(
        `unknown command: /${parsed.name} (type /help for a list of commands)`,
      );
      return { handled: true, unknown: true, name: parsed.name };
    }

    try {
      await command.run(ctx, parsed.args, parsed.raw);
    } catch (error) {
      // A command (extension or built-in) must never reject into onSubmit as
      // an unhandled promise failure. Contain it and show a user-visible line.
      const message = error instanceof Error ? error.message : String(error);
      try {
        ctx.appendLine(`command /${command.name} failed: ${message}`);
      } catch {
        // Reporting must not turn a contained failure into a new one.
      }
      return {
        handled: true,
        name: command.name,
        error: message,
      };
    }
    return { handled: true, exit: command.exits === true, name: command.name };
  }
}

/**
 * Build the command registry. `skills` become first-class commands so a skill
 * is invoked through exactly the same dispatch path as a built-in.
 */
export function createCommandRegistry(
  options: {
    skills?: Skill[];
    extensionCommands?: any[];
    promptTemplates?: PromptTemplate[];
  } = {},
): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({
    name: "help",
    aliases: ["?"],
    description: "show commands",
    category: "General",
    run(ctx) {
      ctx.appendLine(registry.helpText());
    },
  });

  registry.register({
    name: "model",
    description: "search or switch model",
    category: "Model",
    argumentHint: "[model|provider/model]",
    run(ctx, args) {
      if (!args) ctx.openModelPicker();
      else ctx.switchModel(args);
    },
  });

  registry.register({
    name: "provider",
    description: "add or select provider",
    category: "Model",
    argumentHint: "[profile]",
    run(ctx, args) {
      if (args) ctx.startProviderSetup(args);
      else ctx.openProviderPicker();
    },
  });

  registry.register({
    name: "effort",
    description: "set effort level (alias for /thinking)",
    category: "Model",
    argumentHint: "[level]",
    run(ctx, args) {
      if (!args) {
        ctx.openThinkingPicker();
        return;
      }
      ctx.setEffort(args as any);
    },
  });

  registry.register({
    name: "thinking",
    description: "set thinking level",
    category: "Model",
    argumentHint: "[off|minimal|low|medium|high|xhigh|max]",
    run(ctx, args) {
      if (!args) {
        ctx.openThinkingPicker();
        return;
      }
      ctx.setEffort(args as any);
    },
  });

  registry.register({
    name: "agents",
    description: "list primary agents",
    category: "Agent",
    run(ctx) {
      const agents = ctx
        .listAgents()
        .filter((agent) => agent.mode === "primary");
      if (agents.length === 0) {
        ctx.appendLine("no primary agents found");
        return;
      }
      const width = Math.max(...agents.map((agent) => agent.name.length));
      const lines = ["Agents:"];
      for (const agent of agents) {
        const marker = agent.active ? "*" : " ";
        const description = agent.description ? `  ${agent.description}` : "";
        lines.push(`  ${marker} ${agent.name.padEnd(width)}${description}`);
      }
      ctx.appendLine(lines.join("\n"));
    },
  });

  registry.register({
    name: "agent",
    description: "switch primary agent",
    category: "Agent",
    argumentHint: "[name]",
    run(ctx, args) {
      const name = args.trim();
      if (!name) {
        ctx.openAgentPicker();
        return;
      }
      const agents = ctx.listAgents();
      const match = agents.find((agent) => agent.name === name);
      if (!match) {
        const available = agents
          .filter((agent) => agent.mode === "primary")
          .map((agent) => agent.name)
          .join(", ");
        ctx.appendLine(
          `unknown agent: ${name}${available ? ` (available: ${available})` : ""}`,
        );
        return;
      }
      if (match.mode !== "primary") {
        ctx.appendLine(`agent ${name} is not a primary agent`);
        return;
      }
      ctx.activateAgent(name);
    },
  });

  registry.register({
    name: "goal",
    description: "set or control the session goal",
    category: "Agent",
    argumentHint:
      "[set <statement>|criteria <list>|constraints <text>|pause|resume|clear|complete [evidence]|status]",
    run(ctx, args) {
      const runtime = ctx.runtime;
      if (!runtime || typeof runtime.getGoal !== "function") {
        ctx.appendLine("goal unavailable");
        return;
      }
      const usage =
        "usage: /goal set <statement>|criteria <list>|constraints <text>|pause|resume|clear|complete [evidence]|status";
      const trimmed = (args ?? "").trim();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const sub = (match?.[1] ?? "status").toLowerCase();
      const rest = (match?.[2] ?? "").trim();

      if (sub === "set") {
        if (!rest) {
          ctx.appendLine(usage);
          return;
        }
        runtime.setGoal(rest, ctx.session);
        ctx.appendLine(`goal set: ${rest}`);
      } else if (sub === "criteria") {
        if (!rest) {
          ctx.appendLine(usage);
          return;
        }
        const criteria = rest
          .split(/\r?\n|;/)
          .map((line) => line.trim())
          .filter(Boolean);
        runtime.setGoalCriteria(criteria, ctx.session);
        ctx.appendLine(
          `success criteria: ${criteria.length ? criteria.join("; ") : "(none)"}`,
        );
      } else if (sub === "constraints") {
        runtime.setGoalConstraints(rest, ctx.session);
        ctx.appendLine(rest ? `constraints: ${rest}` : "constraints cleared");
      } else if (sub === "pause") {
        runtime.pauseGoal(ctx.session);
        ctx.appendLine("goal paused");
      } else if (sub === "resume") {
        runtime.resumeGoal(ctx.session);
        ctx.appendLine("goal resumed");
        if (!ctx.isTurnActive?.()) void ctx.runTurn("continue");
      } else if (sub === "clear") {
        runtime.clearGoal(ctx.session);
        ctx.appendLine("goal cleared");
      } else if (sub === "complete") {
        const result = runtime.completeGoal(rest || undefined, ctx.session);
        if (result?.ok) {
          ctx.appendLine("goal complete");
        } else {
          ctx.appendLine(
            `goal not complete: unmet criteria: ${(result?.unmet ?? []).join("; ") || "no goal is set"}`,
          );
        }
      } else if (sub === "status") {
        const goal = runtime.getGoal();
        if (!goal) {
          ctx.appendLine("no goal set");
        } else {
          const todos: any[] = runtime.getTodos?.() ?? [];
          const open = todos.filter(
            (item) =>
              item.status === "pending" || item.status === "in_progress",
          ).length;
          const lines = [
            `Goal: ${goal.statement}`,
            `Status: ${goal.status}`,
            "Success criteria:",
            ...(goal.criteria.length
              ? goal.criteria.map((criterion: string) => `  - ${criterion}`)
              : ["  - (none declared)"]),
          ];
          if (goal.constraints) lines.push(`Constraints: ${goal.constraints}`);
          lines.push(`Todos: ${open} open of ${todos.length}`);
          ctx.appendLine(lines.join("\n"));
        }
      } else {
        ctx.appendLine(`unknown goal subcommand: ${sub}`);
        ctx.appendLine(usage);
        return;
      }
      ctx.updateStatus();
    },
  });

  registry.register({
    name: "rename",
    aliases: ["session"],
    description: "session info or rename",
    category: "Session",
    argumentHint: "[rename <title>]",
    run(ctx, args) {
      if (args === "rename" || args.startsWith("rename ")) {
        const title = args.slice("rename".length).trim();
        if (!title) {
          ctx.appendLine("usage: /rename rename <title>");
          return;
        }
        ctx.renameSession(title);
        return;
      }
      const session = ctx.session;
      ctx.appendLine(
        `session: ${session.id}\nworkspace: ${session.workspace}\nprovider: ${session.provider}\nmessages: ${session.messages.length}`,
      );
    },
  });

  registry.register({
    name: "sessions",
    description: "search or resume a session",
    category: "Session",
    argumentHint: "[all]",
    run(ctx, args) {
      ctx.openSessionsPicker(args.trim() === "all" ? "all" : "workspace");
    },
  });

  registry.register({
    name: "cd",
    aliases: ["chdir"],
    description: "change the working directory",
    category: "Session",
    argumentHint: "<directory>",
    run(ctx, args) {
      const target = args.trim();
      if (!target) {
        ctx.appendLine("usage: /cd <directory>");
        return;
      }
      ctx.changeDirectory(expandDirectoryPath(target));
    },
  });

  registry.register({
    name: "search",
    description: "search sessions by title or content",
    category: "Session",
    argumentHint: "<query>",
    run(ctx, args) {
      const query = args.trim();
      if (!query) {
        ctx.appendLine("usage: /search <query>");
        return;
      }
      ctx.searchSessions(query);
    },
  });

  registry.register({
    name: "compact",
    description: "compact history",
    category: "Session",
    argumentHint: "[focus]",
    async run(ctx, args) {
      await ctx.runCompact(args);
    },
  });

  registry.register({
    name: "usage",
    description: "show per-model usage breakdown",
    category: "Session",
    run(ctx) {
      ctx.showUsage();
    },
  });

  registry.register({
    name: "diff",
    description: "show workspace changes against git HEAD",
    category: "Session",
    argumentHint: "[--stat] [path]",
    run(ctx, args) {
      const session = ctx.session;
      const tokens = (args ?? "").split(/\s+/).filter(Boolean);
      const statOnly = tokens.includes("--stat");
      const pathFilter = tokens.filter((t) => !t.startsWith("--"))[0];

      const inRepo = (() => {
        try {
          const out = runGit(session.workspace, [
            "rev-parse",
            "--is-inside-work-tree",
          ]);
          return out.trim() === "true";
        } catch {
          return false;
        }
      })();
      if (!inRepo) {
        ctx.appendLine("diff unavailable: not a git repository");
        return;
      }

      type Entry = { path: string; status: "added" | "modified" | "deleted" };
      const entries: Entry[] = [];
      const nameStatus = runGit(session.workspace, [
        "diff",
        "--name-status",
        "HEAD",
        ...(pathFilter ? ["--", pathFilter] : []),
      ]);
      for (const line of nameStatus.split("\n").filter(Boolean)) {
        const [code, ...rest] = line.split("\t");
        const p = rest.join("\t");
        if (code.startsWith("A")) entries.push({ path: p, status: "added" });
        else if (code.startsWith("D"))
          entries.push({ path: p, status: "deleted" });
        else entries.push({ path: p, status: "modified" });
      }
      const untracked = runGit(session.workspace, [
        "ls-files",
        "--others",
        "--exclude-standard",
        ...(pathFilter ? ["--", pathFilter] : []),
      ]);
      for (const p of untracked.split("\n").filter(Boolean)) {
        entries.push({ path: p, status: "added" });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));

      if (!entries.length) {
        ctx.appendLine("(no changes)");
        return;
      }
      if (statOnly) {
        const counts = { added: 0, modified: 0, deleted: 0 };
        for (const e of entries) counts[e.status]++;
        const noun = entries.length === 1 ? "file" : "files";
        ctx.appendLine(
          `${entries.length} ${noun} changed: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted\n` +
            entries.map((e) => `${e.status.padEnd(8)} ${e.path}`).join("\n"),
        );
        return;
      }
      const lines: string[] = [];
      // One diff invocation for every entry, then bucket the output by path:
      // spawning git per file would be O(entries) subprocesses.
      const all = runGit(session.workspace, [
        "diff",
        "HEAD",
        "--no-color",
        ...(pathFilter ? ["--", pathFilter] : []),
      ]);
      const byPath = new Map<string, string[]>();
      let current: string | undefined;
      for (const l of all.split("\n")) {
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
        if (m) {
          current = m[2];
          byPath.set(current, []);
        } else if (current) {
          byPath.get(current)!.push(l);
        }
      }
      for (const e of entries) {
        lines.push(`${e.status.padEnd(8)} ${e.path}`);
        if (e.status !== "added") {
          for (const l of byPath.get(e.path) ?? []) {
            lines.push("  " + l);
          }
        }
      }
      ctx.appendLine(lines.join("\n"));
    },
  });

  registry.register({
    name: "undo",
    description: "undo the last turn",
    category: "Session",
    async run(ctx) {
      if (typeof ctx.runUndo === "function") await ctx.runUndo();
      else ctx.appendLine("Nothing to undo");
    },
  });

  registry.register({
    name: "redo",
    description: "redo the last undone turn",
    category: "Session",
    async run(ctx) {
      if (typeof ctx.runRedo === "function") await ctx.runRedo();
      else ctx.appendLine("Nothing to redo");
    },
  });

  registry.register({
    name: "btw",
    description: "ask a side question (not added to history)",
    category: "Session",
    argumentHint: "[question]",
    async run(ctx, args) {
      const question = (args ?? "").trim();
      if (typeof ctx.runBtw === "function") {
        await ctx.runBtw(question);
      } else if (!question) {
        ctx.appendLine("usage: /btw <question>");
      } else {
        ctx.appendLine("btw unavailable");
      }
    },
  });

  registry.register({
    name: "new",
    aliases: ["clear"],
    description: "start a new session",
    category: "Session",
    run(ctx) {
      ctx.newSession();
    },
  });

  registry.register({
    name: "approval",
    description: "approval mode",
    category: "Safety",
    run(ctx) {
      const approvals = ctx.approvals;
      ctx.appendLine(
        `approval mode: ${approvals.mode}\ntrusted this session: ${approvals.isTrusted()}`,
      );
    },
  });

  registry.register({
    name: "doctor",
    description: "diagnostics",
    category: "System",
    async run(ctx) {
      ctx.appendLine(await ctx.runDoctor());
    },
  });

  registry.register({
    name: "mcp",
    description: "list or reconnect MCP servers",
    category: "System",
    argumentHint: "[reconnect [server]]",
    async run(ctx, args) {
      await ctx.runMcp(args);
    },
  });

  registry.register({
    name: "export",
    description: "export session transcript",
    category: "Session",
    argumentHint: "[path] [--format md|json] [--force] [--no-redact]",
    async run(ctx, args) {
      await ctx.runExport(args);
    },
  });
  registry.register({
    name: "thinking",
    description: "toggle thinking display",
    category: "System",
    run(ctx) {
      ctx.toggleThinking();
    },
  });

  registry.register({
    name: "theme",
    description: "choose a colour theme",
    category: "Appearance",
    argumentHint: "[auto|dark|light|ansi]",
    run(ctx, args) {
      if (args) ctx.setTheme(args);
      else ctx.openThemePicker();
    },
  });

  registry.register({
    name: "skills",
    description: "list skills",
    category: "Skills",
    run(ctx) {
      const skills = ctx.listSkills();
      if (skills.length === 0) {
        ctx.appendLine("no skills available");
        return;
      }
      ctx.appendLine(
        skills
          .map((skill) => `${skill.name} - ${skill.description}`)
          .join("\n"),
      );
    },
  });

  registry.register({
    name: "skill",
    description: "load a skill",
    category: "Skills",
    argumentHint: "<name> [prompt]",
    async run(ctx, args) {
      const [name, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!name) {
        ctx.appendLine("usage: /skill <name> [prompt]");
        return;
      }
      await ctx.loadSkill(name, rest.join(" ").trim());
    },
  });

  registry.register({
    name: "extensions",
    description:
      "list discovered extensions and load status; use /extensions doctor for diagnostics",
    category: "Extensions",
    argumentHint: "[doctor [--json]]",
    run(ctx, args) {
      const [mode, ...rest] = args.trim().split(/\s+/);
      if (mode === "doctor") {
        const json = rest.includes("--json");
        ctx.appendLine(
          json ? ctx.extensionDoctorJson() : ctx.extensionDoctor(),
        );
      } else {
        ctx.appendLine(ctx.listExtensions());
      }
    },
  });
  registry.register({
    name: "reload",
    description: "reload extensions, skills, and agent personas from disk",
    category: "Extensions",
    run: async (ctx) => {
      await ctx.reloadExtensions();
    },
  });

  registry.register({
    name: "trust",
    description:
      "manage project trust for extensions/agents: allow, deny, or reset",
    category: "Extensions",
    argumentHint: "[allow|deny|reset]",
    run(ctx, args) {
      const sub = args.trim().toLowerCase();
      if (!sub || !["allow", "deny", "reset"].includes(sub)) {
        ctx.appendLine("usage: /trust allow|deny|reset");
        return;
      }
      ctx.setProjectTrust(sub as "allow" | "deny" | "reset");
    },
  });

  registry.register({
    name: "keybindings",
    description: "open the keybindings config file",
    category: "System",
    run(ctx) {
      ctx.openKeybindings();
    },
  });
  registry.register({
    name: "shortcuts",
    description: "list keyboard shortcuts",
    category: "System",
    run(ctx) {
      ctx.appendLine(ctx.shortcutsText());
    },
  });
  registry.register({
    name: "exit",
    aliases: ["quit", "q"],
    description: "exit atom-lite",
    category: "System",
    exits: true,
    run(ctx) {
      ctx.requestExit();
    },
  });

  for (const command of options.extensionCommands ?? []) {
    registry.register({
      name: command.name,
      description: command.description ?? "",
      category: command.category ?? "Extensions",
      argumentHint: command.argumentHint,
      async run(ctx, args) {
        // Extension handlers get the same ExtensionContext tools and hooks
        // receive. Built-ins keep CommandContext untouched.
        const handlerCtx = (command as any).extensionContext ?? ctx;
        if (typeof command.run === "function") {
          await command.run(args, handlerCtx);
        } else if (typeof command.handler === "function") {
          await command.handler(args, handlerCtx);
        }
      },
    });
  }

  for (const skill of options.skills ?? []) {
    registry.register({
      name: skill.name,
      description: skill.description,
      category: "Skills",
      argumentHint: "[prompt]",
      bareInvokable: true,
      async run(ctx, args) {
        await ctx.loadSkill(skill.name, args.trim());
      },
    });
  }

  for (const template of options.promptTemplates ?? []) {
    registry.register({
      name: template.name,
      description: template.description,
      category: "Prompts",
      argumentHint: "[arguments]",
      async run(ctx, args) {
        await ctx.runTurn(expandPromptTemplate(template.content, args));
      },
    });
  }

  return registry;
}
