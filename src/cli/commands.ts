import type { SlashCommand } from "@earendil-works/pi-tui";
import type { Skill } from "../skills/registry.js";
import { CheckpointStore } from "../runtime/checkpoint-store.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { renderDiff } from "../tools/diff.js";

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
  runCompact(args: string): Promise<void> | void;
  runExport(args: string): Promise<void> | void;
  openModelPicker(): void;
  openProviderPicker(): void;
  openKeybindings(): void;
  shortcutsText(): string;
  openEffortPicker(): void;
  openThemePicker(): void;
  openSessionsPicker(scope: "workspace" | "all"): void;
  searchSessions(query: string): void;
  renameSession(title: string): void;
  listExtensions(): string;
  extensionDoctor(): string;
  reloadExtensions(): Promise<void>;
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
  options: { skills?: Skill[]; extensionCommands?: any[] } = {},
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
    name: "undo",
    description: "restore workspace to a checkpoint",
    category: "Session",
    argumentHint: "[list|<n>] [--keep-untracked] [--yes|--force]",
    run(ctx, args) {
      const session = ctx.session;
      const store = new CheckpointStore(session.workspace, session.id);
      const avail = store.isAvailable();
      if (!avail.available) {
        ctx.appendLine(`undo unavailable: ${avail.reason}`);
        return;
      }
      const tokens = (args ?? "").split(/\s+/).filter(Boolean);
      const keepUntracked = tokens.includes("--keep-untracked");
      const force = tokens.includes("--yes") || tokens.includes("--force");
      const positional = tokens.filter((t) => !t.startsWith("--"));
      if (positional[0] === "list") {
        const list = store.list();
        if (!list.length) {
          ctx.appendLine("no checkpoints");
          return;
        }
        ctx.appendLine(
          list
            .map((m, i) => {
              const label = m.label ? `  ${m.label}` : "";
              return `${i + 1}. ${m.id}  ${new Date(m.createdAt).toISOString()}  ${m.files.length} files${label}`;
            })
            .join("\n"),
        );
        return;
      }
      const list = store.list();
      if (!list.length) {
        ctx.appendLine("no checkpoints");
        return;
      }
      let id = list[0].id;
      if (positional[0] && /^\d+$/.test(positional[0])) {
        const idx = parseInt(positional[0], 10) - 1;
        if (idx < 0 || idx >= list.length) {
          ctx.appendLine("checkpoint not found");
          return;
        }
        id = list[idx].id;
      }
      let preview;
      try {
        preview = store.previewRestore(id, keepUntracked);
      } catch (err) {
        ctx.appendLine(
          `checkpoint no longer available: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      // Non-interactive: refuse unless forced.
      if ((ctx.approvals as any)?.nonInteractive && !force) {
        ctx.appendLine(
          "undo unavailable in non-interactive mode (use --force)",
        );
        return;
      }
      const manifest = store.get(id);
      const skipped = manifest?.skipped ?? [];
      ctx.appendLine(
        `preview:\n  changed: ${preview.changed.join(", ") || "(none)"}\n  restored: ${preview.restored.join(", ") || "(none)"}\n  removed: ${preview.removed.join(", ") || "(none)"}`,
      );
      if (store.isAtCheckpoint(id)) {
        ctx.appendLine("already at checkpoint");
        return;
      }
      // Dirty workspace (modified or removed files) requires --force.
      const dirty = preview.changed.length > 0 || preview.removed.length > 0;
      if (dirty && !force) {
        ctx.appendLine(
          "workspace has changes since checkpoint; rerun with --force to override",
        );
        return;
      }
      if (!force && !tokens.includes("--yes")) {
        ctx.appendLine("rerun with --yes to apply");
        return;
      }
      let result;
      try {
        result = store.restore(id, keepUntracked);
      } catch (err) {
        ctx.appendLine(
          `checkpoint no longer available: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      ctx.appendLine(
        `restored ${result.changed.length + result.restored.length} files; removed ${result.removed.length}; skipped ${skipped.length}`,
      );
      if (typeof (ctx.session as any).appendEvent === "function") {
        try {
          (ctx.session as any).appendEvent({
            type: "checkpoint_restored",
            checkpointId: id,
            changed: result.changed.length,
            restored: result.restored.length,
            removed: result.removed.length,
          });
        } catch {
          // best effort
        }
      }
    },
  });

  registry.register({
    name: "diff",
    description: "show workspace changes since the last checkpoint",
    category: "Session",
    argumentHint: "[--stat] [path]",
    run(ctx, args) {
      const session = ctx.session;
      const store = new CheckpointStore(session.workspace, session.id);
      const avail = store.isAvailable();
      const tokens = (args ?? "").split(/\s+/).filter(Boolean);
      const statOnly = tokens.includes("--stat");
      const pathFilter = tokens.filter((t) => !t.startsWith("--"))[0];
      const hasCheckpoint = store.list().length > 0;
      let entries;
      try {
        entries = store.diff();
      } catch (err) {
        ctx.appendLine(
          `diff unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (pathFilter) {
        entries = entries.filter(
          (e) => e.path === pathFilter || e.path.startsWith(pathFilter + "/"),
        );
      }
      if (!entries.length) {
        if (!hasCheckpoint && !avail.available) {
          ctx.appendLine(
            "diff unavailable: not a git repository and no checkpoints",
          );
        } else {
          ctx.appendLine("(no changes)");
        }
        return;
      }
      if (statOnly) {
        const counts = { added: 0, modified: 0, deleted: 0 };
        for (const e of entries) counts[e.status]++;
        ctx.appendLine(
          `${entries.length} files changed: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted\n` +
            entries.map((e) => `${e.status.padEnd(8)} ${e.path}`).join("\n"),
        );
        return;
      }
      // Detailed: per-file status + line diff for checkpoint-backed entries.
      const cp = hasCheckpoint ? store.list()[0] : undefined;
      const lines: string[] = [];
      for (const e of entries) {
        lines.push(`${e.status.padEnd(8)} ${e.path}`);
        if (cp) {
          const snap = store.snapshotFileContent(cp.id, e.path);
          const curPath = join(session.workspace, e.path);
          let cur: Buffer | null = null;
          try {
            cur = readFileSync(curPath);
          } catch {
            cur = null;
          }
          if (e.status === "modified" && snap && cur) {
            const d = renderDiff(snap.toString("utf8"), cur.toString("utf8"));
            for (const l of d) lines.push("  " + l);
          } else if (e.status === "added" && cur) {
            const d = renderDiff("", cur.toString("utf8"));
            for (const l of d) lines.push("  " + l);
          } else if (e.status === "deleted" && snap) {
            const d = renderDiff(snap.toString("utf8"), "");
            for (const l of d) lines.push("  " + l);
          }
        }
      }
      ctx.appendLine(lines.join("\n"));
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
    description:
      "list discovered extensions and load status; use /extensions doctor for diagnostics",
    category: "Extensions",
    argumentHint: "[doctor]",
    run(ctx, args) {
      if (args.trim() === "doctor") {
        ctx.appendLine(ctx.extensionDoctor());
      } else {
        ctx.appendLine(ctx.listExtensions());
      }
    },
  });
  registry.register({
    name: "reload",
    description: "reload all extensions from disk",
    category: "Extensions",
    run: async (ctx) => {
      await ctx.reloadExtensions();
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
    aliases: ["quit"],
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
        if (typeof command.run === "function") {
          await command.run(args, ctx as any);
        } else if (typeof command.handler === "function") {
          await command.handler(args, ctx as any);
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

  return registry;
}
