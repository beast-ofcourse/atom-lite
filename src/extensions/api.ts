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
import { spawn } from "node:child_process";
import { createDefaultExtensionUI } from "./ui.js";
import { validateExtensionTool } from "./tool-validation.js";
import type {
  ToolMiddlewareHandler,
  ToolMiddlewareRegistration,
} from "./tool-middleware.js";
import {
  consumeService,
  provideService,
  type ServiceRegistry,
} from "./services.js";
import {
  EXTENSION_API_VERSION,
  ExtensionCompatibilityError,
  methodSupported,
  tier3Stub,
} from "./compatibility-error.js";
import {
  EXTENSION_EXEC_MAX_BUFFER,
  EXTENSION_EXEC_TIMEOUT_MS,
  isCommandAllowed,
  isHostAllowed,
  isProviderAllowed,
  isSessionReadAllowed,
  isSessionWriteAllowed,
  isUIAllowed,
  scopeDeniedError,
  type ScopeManifest,
} from "./manifest.js";

export interface ExtensionAPI {
  id: string;
  ui: ExtensionUIContext;
  registerTool(tool: ExtensionTool): void;
  unregisterTool(name: string): void;
  wrapTool(
    name: string,
    handler: (call: any, next: () => Promise<any>) => any,
  ): void;
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
  /** Host-proxied fetch limited to the hosts declared in the manifest. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  log(message: string): void;

  /** Publish a versioned service for sibling extensions to consume. */
  provide(name: string, api: unknown, version: string): void;
  /** Resolve a sibling service by semver range; throws when unavailable. */
  consume<T = unknown>(name: string, versionRange: string): T;

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
  /** Tool wrappers in registration order; scoped to this extension's lifetime. */
  toolMiddleware: ToolMiddlewareRegistration[];
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
  /** Host hook for rejections that must surface as `extension_error`. */
  reportError?: (message: string) => void;
  /** Host hook to drop a provider from model selection in the same call. */
  onProviderUnregistered?: (name: string) => void;
}

export function createExtensionRegistries(): ExtensionRegistries {
  return {
    tools: new Map(),
    toolMiddleware: [],
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
  /** Declared capability scopes; undefined keeps legacy-unscoped behavior. */
  scopes?: ScopeManifest;
  /** Host turn signal, read per call so reloads/turns can cancel children. */
  signal?: () => AbortSignal | undefined;
  /** Host seam for streaming exec output into `tool_output` events. */
  onToolOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** Wrap a tool middleware handler so it runs behind the host's boundary. */
  wrapMiddleware?: (
    toolName: string,
    handler: ToolMiddlewareHandler,
  ) => ToolMiddlewareHandler;
  /** Services shared by the extensions in one load generation. */
  services?: ServiceRegistry;
}

interface ExecRunOptions extends ExecOptions {
  workspace: string;
  turnSignal?: AbortSignal;
  hostOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

/**
 * Cancellable, bounded child process. Replaces the old blocking execFileSync:
 * aborts propagate, output streams through the host seam, and both a timeout
 * and maxBuffer kill the child instead of growing an unbounded string.
 */
function runCancellableExec(
  command: string,
  args: string[],
  run: ExecRunOptions,
): Promise<ExecResult> {
  const timeoutMs = run.timeoutMs ?? EXTENSION_EXEC_TIMEOUT_MS;
  const maxBuffer = run.maxBuffer ?? EXTENSION_EXEC_MAX_BUFFER;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: run.cwd ?? run.workspace,
      env: { ...process.env, ...run.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedSignal: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      for (const candidate of [run.signal, run.turnSignal]) {
        candidate?.removeEventListener("abort", onAbort);
      }
      resolve({ stdout, stderr, exitCode, signal });
    };
    const terminate = (signal: NodeJS.Signals = "SIGTERM"): void => {
      if (settled || child.killed) return;
      killedSignal = signal;
      child.kill(signal);
      // A child that ignores SIGTERM must not outlive the turn.
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000);
      killTimer.unref?.();
    };
    const onAbort = (): void => terminate("SIGTERM");

    const collect = (
      stream: "stdout" | "stderr",
      chunk: Buffer | string,
    ): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const current = stream === "stdout" ? stdout : stderr;
      const room = Math.max(0, maxBuffer - current.length);
      if (stream === "stdout") stdout += text.slice(0, room);
      else stderr += text.slice(0, room);
      run.onOutput?.(stream, text);
      run.hostOutput?.(stream, text);
      if (text.length > room) terminate("SIGTERM");
    };
    child.stdout?.on("data", (chunk: Buffer | string) =>
      collect("stdout", chunk),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      collect("stderr", chunk),
    );

    for (const candidate of [run.signal, run.turnSignal]) {
      if (!candidate) continue;
      if (candidate.aborted) onAbort();
      else candidate.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => terminate("SIGTERM"), timeoutMs);
    timer.unref?.();

    child.on("error", () => finish(killedSignal ? 137 : 1, killedSignal));
    child.on("close", (code, signal) =>
      finish(code ?? (killedSignal ? 137 : 1), signal ?? killedSignal),
    );
  });
}

/** Strip credentials before handing a request to a scoped extension. */
function credentialFreeInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers as any);
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  headers.delete("cookie");
  return { ...init, headers, redirect: "manual" };
}

const FETCH_MAX_REDIRECTS = 5;

export function createExtensionAPI(
  id: string,
  ctx: ExtensionContext,
  registries: ExtensionRegistries,
  sessionId: string,
  options: CreateExtensionAPIOptions = {},
): ExtensionAPI {
  if (typeof ctx.hasUI !== "boolean") ctx.hasUI = false;
  if (!ctx.ui) ctx.ui = createDefaultExtensionUI(registries, ctx);
  const services = options.services ?? new Map();
  const scopes = options.scopes;
  const requireUI = (method: string): void => {
    if (!isUIAllowed(scopes)) throw scopeDeniedError("ui", method);
  };
  // `pi.ui` is a second entry to the same UI surface. Without this wrapper an
  // extension could bypass the gate by calling `pi.ui.select` directly.
  if (scopes && !isUIAllowed(scopes)) {
    const denied = new Proxy(ctx.ui, {
      get(target, property, receiver) {
        if (typeof property === "symbol" || property === "then") {
          return Reflect.get(target, property, receiver);
        }
        return () => {
          throw scopeDeniedError("ui", String(property));
        };
      },
    });
    ctx.ui = denied;
  }
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
    wrapTool: (name, handler) => {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("wrapTool requires a non-empty tool name");
      }
      if (typeof handler !== "function") {
        throw new Error("wrapTool requires a handler function");
      }
      registries.toolMiddleware.push({
        toolName: name,
        extensionId: id,
        handler: options.wrapMiddleware?.(name, handler) ?? handler,
      });
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
      if (!isSessionWriteAllowed(scopes)) {
        throw scopeDeniedError(
          "session",
          "appendEntry",
          "write is not declared",
        );
      }
      if (ctx.sessionManager?.appendEntry) {
        return ctx.sessionManager.appendEntry(type, data);
      }
      registries.entries.push({ type, data });
    },
    getSessionEntries: (filter) => {
      if (!isSessionReadAllowed(scopes)) {
        throw scopeDeniedError(
          "session",
          "getSessionEntries",
          "read is not declared",
        );
      }
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
    getSessionManager: () => {
      if (!isSessionReadAllowed(scopes)) {
        throw scopeDeniedError(
          "session",
          "getSessionManager",
          "read is not declared",
        );
      }
      return ctx.sessionManager;
    },
    setStatus: (part, value) => {
      registries.status.set(part, value);
    },
    notify: (message, level) => {
      // eslint-disable-next-line no-console
      console.error(`[extension:${id}] ${level ?? "info"}: ${message}`);
    },
    registerWidget: (_location, widget) => {
      requireUI("registerWidget");
      registries.widgets.set(widget.id, widget);
    },
    unregisterWidget: (widgetId) => {
      requireUI("unregisterWidget");
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
    setWidget: (key, content, options) => {
      requireUI("setWidget");
      return ctx.ui.setWidget(key, content, options);
    },
    setFooter: (factory) => {
      requireUI("setFooter");
      return ctx.ui.setFooter(factory);
    },
    setHeader: (factory) => {
      requireUI("setHeader");
      return ctx.ui.setHeader(factory);
    },
    setTitle: (title) => {
      requireUI("setTitle");
      return ctx.ui.setTitle(title);
    },
    setWorkingMessage: (message) => {
      requireUI("setWorkingMessage");
      return ctx.ui.setWorkingMessage(message);
    },
    setWorkingVisible: (visible) => {
      requireUI("setWorkingVisible");
      return ctx.ui.setWorkingVisible(visible);
    },
    setWorkingIndicator: (options) => {
      requireUI("setWorkingIndicator");
      return ctx.ui.setWorkingIndicator(options);
    },
    setHiddenThinkingLabel: (label) => {
      requireUI("setHiddenThinkingLabel");
      return ctx.ui.setHiddenThinkingLabel(label);
    },
    getToolsExpanded: () => {
      requireUI("getToolsExpanded");
      return ctx.ui.getToolsExpanded();
    },
    setToolsExpanded: (expanded) => {
      requireUI("setToolsExpanded");
      return ctx.ui.setToolsExpanded(expanded);
    },
    select: (title, options) => {
      requireUI("select");
      return ctx.ui.select(title, options);
    },
    confirm: (title, message) => {
      requireUI("confirm");
      return ctx.ui.confirm(title, message);
    },
    input: (title, placeholder) => {
      requireUI("input");
      return ctx.ui.input(title, placeholder);
    },
    getWorkspace: () => ctx.workspace,
    getSession: () => ({ id: sessionId }),
    isProjectTrusted: () => ctx.trusted,
    registerProvider: (providerOrName: any, config?: any) => {
      if (!isProviderAllowed(scopes)) {
        throw scopeDeniedError("providers", "registerProvider");
      }
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
    exec: async (command, args = [], execOptions = {}) => {
      if (!isCommandAllowed(scopes, command)) {
        throw scopeDeniedError(
          "exec",
          "exec",
          `command '${command}' is not allowlisted`,
        );
      }
      return runCancellableExec(command, args, {
        ...execOptions,
        workspace: ctx.workspace,
        turnSignal: options.signal?.(),
        hostOutput: options.onToolOutput,
      });
    },
    fetch: async (url, init) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw scopeDeniedError("network", "fetch", "invalid URL");
      }
      // Follow redirects ourselves so a denied host cannot be reached through
      // an allowlisted one. Credentials are stripped on every hop.
      for (let hop = 0; ; hop++) {
        target.username = "";
        target.password = "";
        if (!isHostAllowed(scopes, target.hostname)) {
          throw scopeDeniedError(
            "network",
            "fetch",
            `host '${target.hostname}' is not allowlisted`,
          );
        }
        const response = await fetch(
          target.toString(),
          credentialFreeInit(init),
        );
        const location = response.headers.get("location");
        if (
          hop >= FETCH_MAX_REDIRECTS ||
          !location ||
          response.status < 300 ||
          response.status >= 400
        ) {
          return response;
        }
        target = new URL(location, target);
      }
    },
    log: (message) => {
      // eslint-disable-next-line no-console
      console.error(`[extension:${id}] ${message}`);
    },
    provide: (name, api, version) => {
      provideService(services, { name, api, version, extensionId: id });
    },
    consume: <T>(name: string, versionRange: string): T =>
      consumeService(services, name, versionRange) as T,
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
