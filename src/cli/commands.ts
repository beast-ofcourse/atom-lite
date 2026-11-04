import type { SlashCommand } from "@earendil-works/pi-tui";
import type { Skill } from "../skills/registry.js";

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

export type LoadedSkill = Pick<Skill, "name" | "description">;

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
  updateStatus(): void;
  runDoctor(): Promise<string>;
  runMcp(args: string): Promise<void> | void;
  openModelPicker(): void;
  openProviderPicker(): void;
  openEffortPicker(): void;
  openThemePicker(): void;
  openSessionsPicker(scope: "workspace" | "all"): void;
  searchSessions(query: string): void;
  renameSession(title: string): void;
  listExtensions(): string;
  switchModel(target: string): void;
  startProviderSetup(profile: string): void;
  setEffort(level: "low" | "medium" | "high"): void;
  toggleThinking(): boolean;
  setTheme(name: string): void;
  listSkills(): LoadedSkill[];
  loadSkill(name: string, extra: string): Promise<boolean>;
  runTurn(prompt: string): Promise<void>;
  requestExit(): void;
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

    await command.run(ctx, parsed.args, parsed.raw);
    return { handled: true, exit: command.exits === true, name: command.name };
  }
}

const EFFORT_LEVELS = ["low", "medium", "high"] as const;

/**
 * Build the command registry. `skills` become first-class commands so a skill
 * is invoked through exactly the same dispatch path as a built-in.
 */
export function createCommandRegistry(
  options: { skills?: Skill[] } = {},
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
    description: "set effort level",
    category: "Model",
    argumentHint: "[low|medium|high]",
    run(ctx, args) {
      if (!args) {
        ctx.openEffortPicker();
        return;
      }
      if ((EFFORT_LEVELS as readonly string[]).includes(args)) {
        ctx.setEffort(args as (typeof EFFORT_LEVELS)[number]);
      } else {
        ctx.appendLine("usage: /effort low|medium|high");
      }
    },
  });

  registry.register({
    name: "session",
    description: "session info or rename",
    category: "Session",
    argumentHint: "[rename <title>]",
    run(ctx, args) {
      if (args === "rename" || args.startsWith("rename ")) {
        const title = args.slice("rename".length).trim();
        if (!title) {
          ctx.appendLine("usage: /session rename <title>");
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
    run(ctx) {
      ctx.appendLine("compaction is automatic");
    },
  });

  registry.register({
    name: "clear",
    aliases: ["new"],
    description: "clear session",
    category: "Session",
    run(ctx) {
      ctx.clearContent();
      ctx.appendLine("started new session");
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
    name: "thinking",
    description: "toggle thinking display",
    category: "System",
    run(ctx) {
      const shown = ctx.toggleThinking();
      ctx.appendLine(`thinking display: ${shown ? "shown" : "hidden"}`);
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
    description: "list loaded extensions",
    category: "Extensions",
    run(ctx) {
      ctx.appendLine(ctx.listExtensions());
    },
  });

  registry.register({
    name: "exit",
    aliases: ["quit"],
    description: "exit atom-lite",
    category: "System",
    exits: true,
    run(ctx) {
      ctx.requestExit();
    },
  });

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

  return registry;
}
