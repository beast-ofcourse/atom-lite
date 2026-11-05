import type {
  AtomEvent,
  ExecOptions,
  ExecResult,
  ExtensionCommand,
  ExtensionContext,
  ExtensionModel,
  ExtensionProvider,
  ExtensionTool,
  ExtensionWidget,
  ExtensionEventHandler,
} from "./types.js";

export interface ExtensionAPI {
  id: string;
  registerTool(tool: ExtensionTool): void;
  unregisterTool(name: string): void;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  getAllTools(): Array<Record<string, unknown>>;
  registerCommand(command: ExtensionCommand): void;
  unregisterCommand(name: string): void;
  on(event: AtomEvent, handler: ExtensionEventHandler): () => void;
  off(event: AtomEvent, handler: ExtensionEventHandler): void;
  appendEntry(type: string, data: unknown): void;
  getSessionEntries(filter?: { type?: string }): Array<{ type: string; data: unknown }>;
  setStatus(part: string, value: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  registerWidget(location: ExtensionWidget["location"], widget: ExtensionWidget): void;
  unregisterWidget(id: string): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  getWorkspace(): string;
  getSession(): { id: string };
  getSessionManager(): any;
  isProjectTrusted(): boolean;
  registerProvider(provider: ExtensionProvider): void;
  unregisterProvider(name: string): void;
  registerModel(model: ExtensionModel): void;
  exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>;
  log(message: string): void;
}

export interface ExtensionRegistries {
  tools: Map<string, ExtensionTool>;
  commands: Map<string, ExtensionCommand>;
  handlers: Map<AtomEvent, Set<ExtensionEventHandler>>;
  widgets: Map<string, ExtensionWidget>;
  providers: Map<string, ExtensionProvider>;
  models: ExtensionModel[];
  entries: Array<{ type: string; data: unknown }>;
  activeTools: Set<string> | null;
  status: Map<string, string | undefined>;
}

export function createExtensionRegistries(): ExtensionRegistries {
  return {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    widgets: new Map(),
    providers: new Map(),
    models: [],
    entries: [],
    activeTools: null,
    status: new Map(),
  };
}

export function createExtensionAPI(
  id: string,
  ctx: ExtensionContext,
  registries: ExtensionRegistries,
  sessionId: string,
): ExtensionAPI {
  return {
    id,
    registerTool: (tool) => {
      registries.tools.set(tool.name, tool);
    },
    unregisterTool: (name) => {
      registries.tools.delete(name);
    },
    setActiveTools: (names) => {
      registries.activeTools = new Set(names);
    },
    getActiveTools: () => {
      if (registries.activeTools) return [...registries.activeTools];
      return [...registries.tools.keys()];
    },
    getAllTools: () => {
      return [...registries.tools.values()].map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters ?? {},
        exposure: tool.exposure ?? "direct",
        annotations: tool.annotations,
      }));
    },
    registerCommand: (command) => {
      const normalized = { ...command };
      if (!normalized.run && typeof normalized.handler === "function") {
        normalized.run = normalized.handler;
      }
      registries.commands.set(normalized.name, normalized);
    },
    unregisterCommand: (name) => {
      registries.commands.delete(name);
    },
    on: (event, handler) => {
      if (!registries.handlers.has(event)) {
        registries.handlers.set(event, new Set());
      }
      registries.handlers.get(event)!.add(handler);
      return () => registries.handlers.get(event)?.delete(handler);
    },
    off: (event, handler) => {
      registries.handlers.get(event)?.delete(handler);
    },
    appendEntry: (type, data) => {
      if (ctx.sessionManager?.appendEntry) {
        return ctx.sessionManager.appendEntry(type, data);
      }
      registries.entries.push({ type, data });
    },
    getSessionEntries: (filter) => {
      if (ctx.sessionManager?.getEntries) {
        return ctx.sessionManager
          .getEntries()
          .filter((entry: any) =>
            filter?.type
              ? entry?.customType === filter.type || entry?.type === filter.type
              : true,
          );
      }
      return registries.entries.filter((entry) =>
        filter?.type ? entry.type === filter.type : true,
      );
    },
    getSessionManager: () => ctx.sessionManager,
    setStatus: (part, value) => {
      registries.status.set(part, value);
    },
    notify: (message, level) => {
      // eslint-disable-next-line no-console
      console.error(`[extension:${id}] ${level ?? "info"}: ${message}`);
    },
    registerWidget: (_location, widget) => {
      registries.widgets.set(widget.id, widget);
    },
    unregisterWidget: (widgetId) => {
      registries.widgets.delete(widgetId);
    },
    select: () => {
      throw new Error("extension runtime not initialized");
    },
    confirm: () => {
      throw new Error("extension runtime not initialized");
    },
    input: () => {
      throw new Error("extension runtime not initialized");
    },
    getWorkspace: () => ctx.workspace,
    getSession: () => ({ id: sessionId }),
    isProjectTrusted: () => ctx.trusted,
    registerProvider: (provider) => {
      registries.providers.set(provider.name, provider);
    },
    unregisterProvider: (name) => {
      registries.providers.delete(name);
    },
    registerModel: (model) => {
      registries.models.push(model);
    },
    exec: async (command, args = [], options = {}) => {
      const { execFileSync } = await import("node:child_process");
      try {
        const stdout = execFileSync(command, args, {
          cwd: options.cwd ?? ctx.workspace,
          encoding: "utf8",
          timeout: options.timeoutMs,
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          status?: number;
        };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: failure.status ?? 1,
        };
      }
    },
    log: (message) => {
      // eslint-disable-next-line no-console
      console.error(`[extension:${id}] ${message}`);
    },
  };
}
