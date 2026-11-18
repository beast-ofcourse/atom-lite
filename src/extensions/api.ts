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
  ExtensionUIContext,
  ExtensionEventHandler,
} from "./types.js";
import { createDefaultExtensionUI } from "./ui.js";
import { ExtensionObservability } from "./observability.js";
import { validateExtensionTool } from "./tool-validation.js";
import {
  EXTENSION_API_VERSION,
  ExtensionCompatibilityError,
  methodSupported,
  tier3Stub,
} from "./compatibility-error.js";

export interface ExtensionAPI {
  id: string;
  ui: ExtensionUIContext;
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
  getSessionEntries(filter?: {
    type?: string;
  }): Array<{ type: string; data: unknown }>;
  setStatus(part: string, value: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  registerWidget(
    location: ExtensionWidget["location"],
    widget: ExtensionWidget,
  ): void;
  unregisterWidget(id: string): void;
  registerToolRenderer(resolver: any): void;
  registerMessageRenderer(customType: string, renderer: any): void;
  registerEntryRenderer(customType: string, renderer: any): void;
  registerMarkdownTransformer(transformer: any): void;
  registerShortcut(
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: any) => void | Promise<void>;
    },
  ): void;
  registerFlag(name: string, options: any): void;
  getFlag(name: string): boolean | string | undefined;
  addAutocompleteProvider(factory: any): void;
  setWidget(
    key: string,
    content: string[] | ((tui: any, theme: any) => any) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setFooter(
    factory: ((tui: any, theme: any, footerData: any) => any) | undefined,
  ): void;
  setHeader(factory: ((tui: any, theme: any) => any) | undefined): void;
  setTitle(title: string): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: {
    frames?: string[];
    intervalMs?: number;
  }): void;
  setHiddenThinkingLabel(label?: string): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
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
  exec(
    command: string,
    args?: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  log(message: string): void;
  /** Run `fn`, recording its duration and outcome. Re-throws on failure. */
  span(name: string, fn: () => unknown | Promise<unknown>): Promise<unknown>;
  /** Record a counter. Attributes stay in memory; doctor sees counts only. */
  metric(name: string, value: number, attrs?: Record<string, unknown>): void;

  /** Version of this ExtensionAPI surface; use with `supports` to branch. */
  apiVersion: string;
  /**
   * True when `method` exists and is not a Tier 3 stub. It does not validate
   * arguments: `registerTool()` still throws for `exposure: "codemode"` while
   * this returns true for `registerTool`.
   */
  supports(method: string): boolean;

  // Tier 3 stubs. Each throws ExtensionCompatibilityError at the call site.
  getSessionTree(): never;
  forkSession(id?: string): never;
  registerMcpServer(config: Record<string, unknown>): never;
  registerOAuthProvider(config: Record<string, unknown>): never;
  virtualModel(config: Record<string, unknown>): never;
  enableRpcMode(options?: Record<string, unknown>): never;
  registerCustomEditor(name: string, factory: unknown): never;
}

export interface ExtensionRegistries {
  tools: Map<string, ExtensionTool>;
  commands: Map<string, ExtensionCommand>;
  handlers: Map<AtomEvent, Set<ExtensionEventHandler>>;
  widgets: Map<string, ExtensionWidget>;
  uiWidgets: Map<string, any>;
  toolRenderers: any[];
  messageRenderers: Map<string, any>;
  entryRenderers: Map<string, any>;
  markdownTransformers: any[];
  shortcuts: Map<string, any>;
  flags: Map<string, any>;
  flagValues: Map<string, any>;
  autocompleteProviders: any[];
  footerFactory?: any;
  headerFactory?: any;
  title?: string;
  workingMessage?: string;
  workingVisible: boolean;
  workingIndicator?: { frames?: string[]; intervalMs?: number };
  hiddenThinkingLabel?: string;
  toolsExpanded: boolean;
  providers: Map<string, ExtensionProvider>;
  models: ExtensionModel[];
  entries: Array<{ type: string; data: unknown }>;
  activeTools: Set<string> | null;
  status: Map<string, string | undefined>;
  /** Per-extension observability records, bounded and reset on reload. */
  observability: ExtensionObservability;
  /** Host hook for rejections that must surface as `extension_error`. */
  reportError?: (message: string) => void;
  /** Host hook to drop a provider from model selection in the same call. */
  onProviderUnregistered?: (name: string) => void;
}

export function createExtensionRegistries(): ExtensionRegistries {
  return {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    widgets: new Map(),
    uiWidgets: new Map(),
    toolRenderers: [],
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    markdownTransformers: [],
    shortcuts: new Map(),
    flags: new Map(),
    flagValues: new Map(),
    autocompleteProviders: [],
    workingVisible: true,
    toolsExpanded: false,
    providers: new Map(),
    models: [],
    entries: [],
    activeTools: null,
    status: new Map(),
    observability: new ExtensionObservability(),
  };
}

/**
 * Provider config keys the host actually maps when it bridges an extension
 * provider into Atom-lite's provider list. Identity/wrapper keys are not
 * features; anything else declared in the config is silently dropped, so it
 * must be surfaced as a reduced-compatibility warning.
 */
const APPLIED_PROVIDER_CONFIG_KEYS = new Set([
  "baseUrl",
  "apiKey",
  "headers",
  "authHeader",
  "models",
]);

const PROVIDER_IDENTITY_KEYS = new Set(["name", "id", "config"]);

export interface CreateExtensionAPIOptions {
  /** Wrap an event handler so it runs behind the host's boundary. */
  wrapHandler?: (
    event: AtomEvent,
    handler: ExtensionEventHandler,
  ) => ExtensionEventHandler;
}

export function createExtensionAPI(
  id: string,
  ctx: ExtensionContext,
  registries: ExtensionRegistries,
  sessionId: string,
  options: CreateExtensionAPIOptions = {},
): ExtensionAPI {
  if (typeof ctx.hasUI !== "boolean") ctx.hasUI = false;
  if (!ctx.ui) ctx.ui = createDefaultExtensionUI(registries, ctx);
  // Map a registered handler to its wrapped form so `off`/unsubscribe removes
  // exactly what `on` added.
  const wrapped = new Map<
    ExtensionEventHandler,
    Map<AtomEvent, ExtensionEventHandler>
  >();
  return {
    id,
    ui: ctx.ui,
    registerTool: (tool) => {
      if (tool?.exposure === "codemode") {
        throw new ExtensionCompatibilityError({
          method: "registerTool",
          tier: 3,
          reason: "tool exposure 'codemode' is not implemented",
          alternative: "exposure 'direct' or 'model-only'",
        });
      }
      const errors = validateExtensionTool(tool);
      if (errors.length > 0) {
        const name =
          tool && typeof tool.name === "string" ? tool.name : "<unnamed>";
        registries.reportError?.(
          `tool "${name}" rejected at registration: ${errors.join("; ")}`,
        );
        return;
      }
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
      const registered = options.wrapHandler
        ? options.wrapHandler(event, handler)
        : handler;
      registries.handlers.get(event)!.add(registered);
      let byEvent = wrapped.get(handler);
      if (!byEvent) {
        byEvent = new Map();
        wrapped.set(handler, byEvent);
      }
      byEvent.set(event, registered);
      return () => registries.handlers.get(event)?.delete(registered);
    },
    off: (event, handler) => {
      const registered = wrapped.get(handler)?.get(event) ?? handler;
      registries.handlers.get(event)?.delete(registered);
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
    registerToolRenderer: (resolver) => {
      registries.toolRenderers.push(resolver);
    },
    registerMessageRenderer: (customType, renderer) => {
      registries.messageRenderers.set(customType, renderer);
    },
    registerEntryRenderer: (customType, renderer) => {
      registries.entryRenderers.set(customType, renderer);
    },
    registerMarkdownTransformer: (transformer) => {
      registries.markdownTransformers.push(transformer);
    },
    registerShortcut: (shortcut, options) => {
      registries.shortcuts.set(shortcut, options);
    },
    registerFlag: (name, options) => {
      registries.flags.set(name, options);
      if (options?.default !== undefined)
        registries.flagValues.set(name, options.default);
    },
    getFlag: (name) => registries.flagValues.get(name),
    addAutocompleteProvider: (factory) => {
      registries.autocompleteProviders.push(factory);
    },
    setWidget: (key, content, options) =>
      ctx.ui.setWidget(key, content, options),
    setFooter: (factory) => ctx.ui.setFooter(factory),
    setHeader: (factory) => ctx.ui.setHeader(factory),
    setTitle: (title) => ctx.ui.setTitle(title),
    setWorkingMessage: (message) => ctx.ui.setWorkingMessage(message),
    setWorkingVisible: (visible) => ctx.ui.setWorkingVisible(visible),
    setWorkingIndicator: (options) => ctx.ui.setWorkingIndicator(options),
    setHiddenThinkingLabel: (label) => ctx.ui.setHiddenThinkingLabel(label),
    getToolsExpanded: () => ctx.ui.getToolsExpanded(),
    setToolsExpanded: (expanded) => ctx.ui.setToolsExpanded(expanded),
    select: (title, options) => ctx.ui.select(title, options),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    getWorkspace: () => ctx.workspace,
    getSession: () => ({ id: sessionId }),
    isProjectTrusted: () => ctx.trusted,
    registerProvider: (providerOrName: any, config?: any) => {
      const name =
        typeof providerOrName === "string"
          ? providerOrName
          : (providerOrName?.name ?? providerOrName?.id);
      const cfg =
        typeof providerOrName === "string"
          ? (config ?? {})
          : (providerOrName?.config ?? providerOrName ?? {});
      if (!name) {
        // eslint-disable-next-line no-console
        console.error("[extension] registerProvider requires a provider name");
        return;
      }
      const unsupported = Object.keys(cfg).filter(
        (key) =>
          !APPLIED_PROVIDER_CONFIG_KEYS.has(key) &&
          !PROVIDER_IDENTITY_KEYS.has(key),
      );
      if (unsupported.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[extension] provider "${name}" uses reduced-compatibility features: ${unsupported.join(", ")}`,
        );
      }
      registries.providers.set(name, { name, config: { ...cfg } });
    },
    unregisterProvider: (name) => {
      registries.providers.delete(name);
      // Models registered for this provider must leave the selectable set in
      // the same call; otherwise a removed provider keeps offering its models.
      registries.models = registries.models.filter(
        (model) => model.provider !== name,
      );
      // The host keeps its own provider config and model cache for selection.
      // Drop them here so an unregistered model cannot be picked next turn.
      registries.onProviderUnregistered?.(name);
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
    span: (name, fn) => registries.observability.span(name, fn),
    metric: (name, value, attrs) =>
      registries.observability.metric(name, value, attrs),
    apiVersion: EXTENSION_API_VERSION,
    supports: (method) => methodSupported(method),
    getSessionTree: tier3Stub(
      "getSessionTree",
      "session tree navigation is not available",
      "getSessionEntries()",
    ),
    forkSession: tier3Stub(
      "forkSession",
      "session forks are not available",
      "getSessionEntries() to export the transcript",
    ),
    registerMcpServer: tier3Stub(
      "registerMcpServer",
      "runtime MCP server registration is not available",
      "the 'mcpServers' user config key",
    ),
    registerOAuthProvider: tier3Stub(
      "registerOAuthProvider",
      "OAuth providers are not available",
      "registerProvider() with an OpenAI-compatible config",
    ),
    virtualModel: tier3Stub(
      "virtualModel",
      "virtual models are not available",
      "registerModel() for a static descriptor",
    ),
    enableRpcMode: tier3Stub(
      "enableRpcMode",
      "RPC mode is not available",
      "the CLI or web API",
    ),
    registerCustomEditor: tier3Stub(
      "registerCustomEditor",
      "custom editor components are not available",
      "ui.editor() or ui.input() for text entry",
    ),
  };
}
