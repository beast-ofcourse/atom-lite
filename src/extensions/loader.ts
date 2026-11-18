import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { discoverExtensions, type DiscoveredExtension } from "./discovery.js";
import { loadConfig } from "../config/load.js";
import { defaultAgentDir, userConfigDir } from "../config/paths.js";
import { createExtensionAPI, createExtensionRegistries } from "./api.js";
import { createDefaultExtensionUI } from "./ui.js";
import { ExtensionBoundary, type BoundaryError } from "./boundary.js";
import type { ExtensionContext } from "./types.js";
import type { AtomEvent } from "./types.js";
import { ExtensionCompatibilityError } from "./compatibility-error.js";
import {
  PiSessionManager,
  type ExtensionSessionLike,
} from "./session-manager.js";
import {
  compatibilityMatrix,
  type CompatibilityMatrixEntry,
} from "./compatibility-matrix.js";

export interface ExtensionLoaderOptions {
  cliPaths?: string[];
  hasUI?: boolean;
  uiFactory?: (
    registries: ReturnType<typeof createExtensionRegistries>,
    ctx: ExtensionContext,
  ) => ExtensionContext["ui"];
  userDir?: string;
  cwd?: string;
  agentDir?: string;
  projectDir?: string;
  packageRoots?: string[];
  trustedProjects?: string[];
  deniedProjects?: string[];
  onLifecycleEvent?: (event: ExtensionLifecycleEvent) => void;
  /** Maximum time a single extension callback may run before it is timed out. */
  handlerTimeoutMs?: number;
  /** Live session backing the extension session APIs. */
  session?: ExtensionSessionLike;
  /** Keep the lifecycle stream bounded across reloads. */
  maxLifecycleEvents?: number;
  /** Called when an extension unregisters a provider so host selection updates. */
  onProviderUnregistered?: (name: string) => void;
}

export interface LoadedExtension {
  id: string;
  source: string;
  origin?: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped";
  error?: string;
  errorStack?: string;
  registries: ReturnType<typeof createExtensionRegistries>;
  context?: ExtensionContext;
}

interface StagedExtension {
  id: string;
  source: string;
  origin?: string;
  entryPath: string;
  registries: ReturnType<typeof createExtensionRegistries>;
  context: ExtensionContext;
}

/**
 * A complete replacement extension set, built aside by stageExtensions().
 * Nothing in the live host changes until commitStaged() performs the swap.
 */
export interface StagedExtensionSet {
  extensions: LoadedExtension[];
  lifecycle: ExtensionLifecycleEvent[];
  generation: number;
}

export interface ExtensionReport {
  id: string;
  source: string;
  origin?: string;
  version?: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped" | "discovered";
  error?: string;
  trusted: boolean;
  toolCount: number;
  commandCount: number;
}

export interface ExtensionLifecycleEvent {
  type: AtomEvent;
  extensionId: string;
  error?: string;
  /** Event or method name behind a contained failure. */
  method?: string;
  /** Stack of a contained failure. */
  stack?: string;
  /** How a contained failure was classified. */
  phase?: BoundaryError["phase"];
  /** Compatibility tier when the failure came from a deferred API stub. */
  tier?: number;
  /** Suggested replacement when one exists. */
  alternative?: string;
}

/** Lifecycle events delivered to every sibling after the owner is committed. */
const BROADCAST_EVENTS = new Set<AtomEvent>([
  "extension_error",
  "extension_load",
  "extension_activate",
]);

interface PendingBroadcast {
  event: ExtensionLifecycleEvent;
  ownerId: string;
  owner?: {
    registries: ReturnType<typeof createExtensionRegistries>;
    context?: ExtensionContext;
  };
}

export interface ExtensionDiagnostic {
  id: string;
  source: string;
  origin?: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped" | "discovered";
  error?: string;
  stack?: string;
  toolCount: number;
  commandCount: number;
  eventCount: number;
  apis: CompatibilityMatrixEntry[];
  /** Lifecycle stream from lifecycleEvents(), scoped to this extension. */
  lifecycleEvents: ExtensionLifecycleEvent[];
}

export class ExtensionLoader {
  private options: ExtensionLoaderOptions;
  private extensions: LoadedExtension[] = [];
  private discovered: DiscoveredExtension[] = [];
  private lifecycle: ExtensionLifecycleEvent[] = [];
  private jiti: ReturnType<typeof createJiti> | null = null;
  private generation = 0;
  /** Pending generation during staging; null once a set is committed. */
  private stagedGeneration: number | null = null;
  private boundary: ExtensionBoundary;
  private readonly handlerTimeoutMs: number;
  private pendingBroadcasts: PendingBroadcast[] = [];
  private loading = false;
  private readonly maxLifecycleEvents: number;

  constructor(options: ExtensionLoaderOptions = {}) {
    this.options = options;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 5_000;
    this.maxLifecycleEvents = options.maxLifecycleEvents ?? 200;
    this.boundary = this.createBoundary();
  }

  private createBoundary(generation = this.generation): ExtensionBoundary {
    return new ExtensionBoundary({
      generation: () => generation,
      // While staging, both generations are live. The commit removes the old
      // one; a rollback removes the new one and restores the old boundary.
      isLive: () =>
        generation === this.generation || generation === this.stagedGeneration,
      timeoutMs: this.handlerTimeoutMs,
      onError: (error) => this.reportError(error),
    });
  }

  private workspace(): string {
    return resolve(
      this.options.cwd ?? this.options.projectDir ?? process.cwd(),
    );
  }

  private decisions(): { trusted: string[]; denied: string[] } {
    const config = loadConfig();
    return {
      trusted:
        this.options.trustedProjects ??
        config.extensions?.trustedProjects ??
        [],
      denied:
        this.options.deniedProjects ?? config.extensions?.deniedProjects ?? [],
    };
  }

  discover(): DiscoveredExtension[] {
    const cwd = this.workspace();
    const decisions = this.decisions();
    const discovered = discoverExtensions({
      cliPaths: this.options.cliPaths,
      cwd,
      agentDir: this.options.agentDir ?? defaultAgentDir(),
      userDir: this.options.userDir ?? join(userConfigDir(), "extensions"),
      projectDir: join(cwd, ".atom-lite", "extensions"),
      packageRoots: this.options.packageRoots,
      trustedProjects: decisions.trusted,
      deniedProjects: decisions.denied,
    });
    this.discovered = discovered;
    return discovered;
  }

  private getJiti(): ReturnType<typeof createJiti> {
    if (this.jiti) return this.jiti;
    const { alias, virtualModules } = resolveHostModules();
    const instance = createJiti(import.meta.url, {
      moduleCache: false,
      fsCache: false,
      alias,
      virtualModules,
      interopDefault: true,
    });
    this.jiti = instance;
    return instance;
  }

  private createStaging(entry: DiscoveredExtension): StagedExtension {
    const registries = createExtensionRegistries();
    const ctx: ExtensionContext = {
      workspace: this.workspace(),
      trusted: entry.trusted,
      hasUI: this.options.hasUI ?? false,
      ui: null as any,
      log: (message) => {
        console.error(`[extension:${entry.id}] ${message}`);
      },
      // Every extension gets a real read model over the live session. When the
      // host supplied a durable session, appendEntry/getSessionEntries persist
      // through it; otherwise the manager falls back to in-memory state.
      sessionManager: new PiSessionManager({
        session: this.options.session,
        cwd: this.workspace(),
      }),
    };
    ctx.ui =
      this.options.uiFactory?.(registries, ctx) ??
      createDefaultExtensionUI(registries, ctx);
    // Registration rejections are attributed to this extension in the same
    // lifecycle stream as activation failures, so doctor and `extension_error`
    // handlers see them.
    registries.reportError = (message) =>
      this.reportError({
        extensionId: entry.id,
        method: "registerTool",
        message,
        phase: "throw",
      });
    registries.onProviderUnregistered = (name) =>
      this.options.onProviderUnregistered?.(name);
    return {
      id: entry.id,
      source: entry.source,
      origin: entry.origin,
      entryPath: entry.entryPath,
      registries,
      context: ctx,
    };
  }

  /** Bind a handler to the current generation's boundary at registration. */
  private wrapHandler(
    extensionId: string,
    event: AtomEvent,
    handler: (...args: any[]) => unknown | Promise<unknown>,
  ): (...args: any[]) => Promise<unknown> {
    const boundary = this.boundary;
    return (payload: unknown, ctx: ExtensionContext) =>
      boundary.run({ extensionId, method: `on:${event}` }, () =>
        handler(payload, ctx),
      );
  }

  async loadAll(): Promise<LoadedExtension[]> {
    const staged = await this.stageExtensions();
    await this.commitStaged(staged);
    return this.extensions;
  }

  /**
   * Build a replacement set without touching the live extension list. The
   * candidate gets a pending generation, so the outgoing set stays live until
   * commit; a failed stage restores the previous generation and lifecycle log,
   * making a failed reload indistinguishable from no reload apart from the
   * reported error.
   */
  async stageExtensions(): Promise<StagedExtensionSet> {
    const previous = {
      boundary: this.boundary,
      lifecycle: this.lifecycle,
      stagedGeneration: this.stagedGeneration,
      // Copy: staging appends to the same array, so a reference would be
      // mutated and a rollback would restore nothing.
      pendingBroadcasts: [...this.pendingBroadcasts],
    };
    const generation = this.generation + 1;
    this.stagedGeneration = generation;
    this.boundary = this.createBoundary(generation);
    this.lifecycle = [];
    try {
      const extensions = await this.buildExtensions();
      return { extensions, lifecycle: this.lifecycle, generation };
    } catch (error) {
      this.boundary = previous.boundary;
      this.lifecycle = previous.lifecycle;
      this.stagedGeneration = previous.stagedGeneration;
      // Events queued mid-stage belong to the discarded set. Without this a
      // later commit flushes them into the replacement set.
      this.pendingBroadcasts = previous.pendingBroadcasts;
      this.loading = false;
      throw error;
    }
  }

  /**
   * Commit a staged set as the one atomic swap, then deliver the lifecycle
   * events queued during staging to their owner and siblings in the live set.
   */
  async commitStaged(staged: StagedExtensionSet): Promise<void> {
    this.extensions = staged.extensions;
    this.lifecycle = staged.lifecycle;
    this.generation = staged.generation;
    this.stagedGeneration = null;
    this.loading = false;
    // Siblings see lifecycle events only once the new set is live. A handler
    // registered during staging cannot observe an extension from the old set.
    await this.flushBroadcasts();
  }

  private async buildExtensions(): Promise<LoadedExtension[]> {
    const discovered = this.discover();
    // Extension state is built aside and only committed by the caller.
    // A factory that throws must leave no registrations in the running host.
    const staged: LoadedExtension[] = [];
    this.loading = true;

    for (const entry of discovered) {
      const staging = this.createStaging(entry);

      if (entry.errors.length > 0) {
        const error = entry.errors.join("; ");
        await this.recordLifecycle(
          "extension_error",
          entry.id,
          error,
          staging.registries,
          staging.context,
        );
        staged.push({ ...staging, status: "skipped", error });
        continue;
      }

      if (entry.skipReason) {
        staged.push({ ...staging, status: "skipped", error: entry.skipReason });
        continue;
      }

      try {
        const jiti = this.getJiti();
        // Import once. jiti's `default: true` returns the default export when
        // present, otherwise the module object (so named `activate` still
        // resolves).
        const imported = (await jiti.import(entry.entryPath, {
          default: true,
        })) as unknown;
        const moduleExports =
          imported && typeof imported === "object"
            ? (imported as Record<string, unknown>)
            : {};
        const factory =
          typeof imported === "function"
            ? imported
            : typeof moduleExports.default === "function"
              ? moduleExports.default
              : typeof moduleExports.activate === "function"
                ? moduleExports.activate
                : undefined;

        if (typeof factory !== "function") {
          throw new Error(
            "extension must export a default or activate function",
          );
        }

        const api = createExtensionAPI(
          entry.id,
          staging.context,
          staging.registries,
          (staging.context.sessionManager as PiSessionManager).getId(),
          {
            wrapHandler: (event, handler) =>
              this.wrapHandler(entry.id, event, handler),
          },
        );
        api.ui = staging.context.ui;
        await factory(api);
        await this.recordLifecycle(
          "extension_load",
          entry.id,
          undefined,
          staging.registries,
          staging.context,
        );
        await this.recordLifecycle(
          "extension_activate",
          entry.id,
          undefined,
          staging.registries,
          staging.context,
        );
        staged.push({ ...staging, status: "loaded" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorStack =
          error instanceof Error ? (error.stack ?? error.message) : message;
        // A compatibility stub carries structured context. Surface it on the
        // lifecycle event so doctor names the method, tier, and alternative.
        const detail =
          error instanceof ExtensionCompatibilityError
            ? {
                method: error.method,
                tier: error.tier,
                ...(error.alternative
                  ? { alternative: error.alternative }
                  : {}),
                stack: errorStack,
              }
            : {};
        // Discard the staged registries: the error record gets a fresh,
        // empty staging record so it exposes zero registrations.
        const failure = this.createStaging(entry);
        await this.recordLifecycle(
          "extension_error",
          entry.id,
          message,
          failure.registries,
          failure.context,
          detail,
        );
        staged.push({
          ...failure,
          status: "error",
          error: message,
          errorStack,
        });
      }
    }
    // Staging only: the caller commits the new set atomically. Queued lifecycle
    // events are delivered once that commit makes the set live.
    return staged;
  }

  private pushEvent(event: ExtensionLifecycleEvent): void {
    this.lifecycle.push(event);
    // Reloads emit events indefinitely; keep doctor's stream recent and bounded.
    if (this.lifecycle.length > this.maxLifecycleEvents) {
      this.lifecycle.splice(0, this.lifecycle.length - this.maxLifecycleEvents);
    }
    try {
      this.options.onLifecycleEvent?.(event);
    } catch {
      // A reporting callback must never break the extension host.
    }
  }

  private async recordLifecycle(
    type: AtomEvent,
    extensionId: string,
    error?: string,
    registries?: ReturnType<typeof createExtensionRegistries>,
    ctx?: ExtensionContext,
    detail: Partial<ExtensionLifecycleEvent> = {},
  ): Promise<void> {
    const event: ExtensionLifecycleEvent = {
      type,
      extensionId,
      error,
      ...detail,
    };
    this.pushEvent(event);
    if (BROADCAST_EVENTS.has(type)) {
      // Deliver to the owner and its siblings together, after the swap.
      this.pendingBroadcasts.push({
        event,
        ownerId: extensionId,
        owner: registries ? { registries, context: ctx } : undefined,
      });
      return;
    }
    const targets = registries
      ? [{ registries, context: ctx }]
      : this.extensions.map((loaded) => ({
          registries: loaded.registries,
          context: loaded.context,
        }));
    for (const target of targets) {
      await this.dispatchHandlers(event, target.registries, target.context);
    }
  }

  private async flushBroadcasts(): Promise<void> {
    const pending = this.pendingBroadcasts.splice(0);
    for (const { event, ownerId, owner } of pending) {
      if (owner) {
        await this.dispatchHandlers(event, owner.registries, owner.context);
      }
      for (const loaded of this.extensions) {
        if (loaded.id === ownerId || loaded.status !== "loaded") continue;
        await this.dispatchHandlers(event, loaded.registries, loaded.context);
      }
    }
  }

  /**
   * Handlers registered through the API are already wrapped in a Boundary.
   * The safety net here covers handlers injected directly into a registry, so
   * no callback can leave an unhandled rejection behind.
   */
  private async dispatchHandlers(
    event: ExtensionLifecycleEvent,
    registries: ReturnType<typeof createExtensionRegistries>,
    ctx?: ExtensionContext,
  ): Promise<void> {
    const handlers = registries.handlers.get(event.type);
    if (!handlers) return;
    await Promise.all(
      [...handlers].map((handler) =>
        Promise.resolve()
          .then(() => handler(event, ctx!))
          .catch((error) => {
            const err =
              error instanceof Error ? error : new Error(String(error));
            // A failure inside a broadcast must not queue another broadcast.
            this.reportError(
              {
                extensionId: event.extensionId,
                method: `on:${event.type}`,
                message: err.message,
                stack: err.stack,
                phase: "reject",
              },
              false,
            );
          }),
      ),
    );
  }

  /** Record one contained failure so it is visible in doctor exactly once. */
  reportError(error: BoundaryError, broadcast = true): void {
    const event: ExtensionLifecycleEvent = {
      type: "extension_error",
      extensionId: error.extensionId,
      error: error.message,
      method: error.method,
      stack: error.stack,
      phase: error.phase,
    };
    this.pushEvent(event);
    if (broadcast && this.loading) {
      this.pendingBroadcasts.push({ event, ownerId: error.extensionId });
    }
  }

  /**
   * Run an extension callback (e.g. a command) behind the current boundary.
   * The command must belong to a currently loaded extension: a callback kept
   * from a failed reload must not run against the new set.
   */
  runBounded<T>(
    meta: { extensionId: string; method: string },
    fn: () => T | Promise<T>,
    options?: { rethrow?: boolean },
  ): Promise<T | undefined> {
    const live = this.extensions.some(
      (entry) => entry.id === meta.extensionId && entry.status === "loaded",
    );
    if (!live) {
      this.reportError({
        extensionId: meta.extensionId,
        method: meta.method,
        message: "extension is not loaded",
        phase: "stale",
      });
      return Promise.resolve(undefined);
    }
    return this.boundary.run(meta, fn, options);
  }

  /** Report a host-level failure that has no single owning extension. */
  reportTopLevelError(error: unknown, method: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? message) : message;
    this.reportError({
      extensionId: "app",
      method,
      message,
      stack,
      phase: "reject",
    });
    process.stderr.write(`atom-lite: extension ${method} failed: ${message}\n`);
  }

  list(): LoadedExtension[] {
    return [...this.extensions];
  }

  /** The extensions whose activation succeeded and whose state is live. */
  loadedExtensions(): LoadedExtension[] {
    return this.extensions.filter((entry) => entry.status === "loaded");
  }

  processedCount(): number {
    return this.extensions.filter((entry) => entry.status === "loaded").length;
  }

  lifecycleEvents(): ExtensionLifecycleEvent[] {
    return [...this.lifecycle];
  }

  /**
   * Deliver a host-owned event to every loaded extension, awaiting each
   * handler. Single dispatch seam for turn and host events; a rejecting
   * handler is contained as `extension_error` instead of escaping.
   */
  async dispatchEvent(event: AtomEvent, payload?: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const loaded of this.loadedExtensions()) {
      const handlers = loaded.registries.handlers.get(event);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          results.push(await handler(payload, loaded.context ?? ({} as any)));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.reportError(
            {
              extensionId: loaded.id,
              method: `on:${event}`,
              message: err.message,
              stack: err.stack,
              phase: "reject",
            },
            false,
          );
        }
      }
    }
    return results;
  }

  report(): ExtensionReport[] {
    if (this.discovered.length === 0) this.discover();
    const loadedByPath = new Map(
      this.extensions.map((entry) => [entry.entryPath, entry]),
    );
    return this.discovered.map((entry) => {
      const loaded = loadedByPath.get(entry.entryPath);
      return {
        id: entry.id,
        source: entry.source,
        origin: entry.origin,
        version: entry.manifest?.version,
        entryPath: entry.entryPath,
        status: loaded?.status ?? (entry.skipReason ? "skipped" : "discovered"),
        error: loaded?.error ?? (entry.errors.join("; ") || entry.skipReason),
        trusted: entry.trusted,
        toolCount: loaded?.registries.tools.size ?? 0,
        commandCount: loaded?.registries.commands.size ?? 0,
      };
    });
  }

  diagnostics(): ExtensionDiagnostic[] {
    if (this.discovered.length === 0) this.discover();
    const loadedByPath = new Map(
      this.extensions.map((entry) => [entry.entryPath, entry]),
    );
    return this.discovered.map((entry) => {
      const loaded = loadedByPath.get(entry.entryPath);
      const error =
        loaded?.error ?? (entry.errors.join("; ") || entry.skipReason);
      return {
        id: entry.id,
        source: entry.source,
        origin: entry.origin,
        entryPath: entry.entryPath,
        status: loaded?.status ?? (entry.skipReason ? "skipped" : "discovered"),
        error: error || undefined,
        stack: loaded?.errorStack,
        toolCount: loaded?.registries.tools.size ?? 0,
        commandCount: loaded?.registries.commands.size ?? 0,
        eventCount: loaded?.registries.handlers.size ?? 0,
        apis: calledMatrixApis(entry.entryPath),
        lifecycleEvents: this.lifecycle.filter(
          (event) => event.extensionId === entry.id,
        ),
      };
    });
  }

  doctorJson(): string {
    return JSON.stringify(this.diagnostics(), null, 2);
  }

  doctor(): string {
    if (this.discovered.length === 0) this.discover();
    const loadedByPath = new Map(
      this.extensions.map((entry) => [entry.entryPath, entry]),
    );
    const lines: string[] = [];
    for (const entry of this.discovered) {
      const loaded = loadedByPath.get(entry.entryPath);
      const status =
        loaded?.status ?? (entry.skipReason ? "skipped" : "discovered");
      const error =
        loaded?.error ?? (entry.errors.join("; ") || entry.skipReason);
      const counts = loaded
        ? `${loaded.registries.tools.size} tools, ${loaded.registries.commands.size} commands, ${loaded.registries.handlers.size} event types`
        : "not loaded";
      lines.push(
        `${entry.id}\t${entry.source}${entry.origin ? `:${entry.origin}` : ""}\t${entry.manifest?.version ?? "-"}\t${status}\t${counts}\t${entry.entryPath}${error ? `\t${error}` : ""}`,
      );
    }
    const base = lines.join("\n") || "No extensions discovered.";
    const errors = this.lifecycle.filter(
      (event) => event.type === "extension_error",
    );
    if (errors.length === 0) return base;
    const errorLines = errors.map(
      (event) =>
        `error\t${event.extensionId}\t${event.method ?? "unknown"}\t${event.phase ?? "reject"}\t${event.error ?? ""}${event.stack ? `\t${event.stack.split("\n")[0]}` : ""}`,
    );
    return `${base}\nboundary errors:\n${errorLines.join("\n")}`;
  }

  async notifySessionEnd(): Promise<void> {
    await Promise.all(
      this.extensions.map((loaded) =>
        this.recordLifecycle(
          "session_end",
          loaded.id,
          undefined,
          loaded.registries,
          loaded.context,
        ),
      ),
    );
  }

  async unloadAll(): Promise<void> {
    await Promise.all(
      this.extensions.map((loaded) =>
        this.recordLifecycle(
          "extension_unload",
          loaded.id,
          undefined,
          loaded.registries,
          loaded.context,
        ),
      ),
    );
    this.extensions = [];
    this.jiti = null;
    this.stagedGeneration = null;
    this.generation++;
    this.boundary = this.createBoundary();
  }
}

/** Matrix entries for API methods that appear as calls in an extension file. */
function calledMatrixApis(entryPath: string): CompatibilityMatrixEntry[] {
  let source: string;
  try {
    source = readFileSync(entryPath, "utf8");
  } catch {
    return [];
  }
  const called = new Set(
    [...source.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]),
  );
  return compatibilityMatrix.filter((entry) => called.has(entry.method));
}

/**
 * Provider aliases for Pi-compatible host modules. Modules that have no real
 * install are served as in-memory stubs instead of empty files written under
 * `node_modules/.atom-lite-shims`. Modules that are genuinely missing and have
 * no host stub are left unresolved so the extension fails loudly.
 */
function resolveHostModules(): {
  alias: Record<string, string>;
  virtualModules: Record<string, unknown>;
} {
  const require = createRequire(import.meta.url);
  const alias: Record<string, string> = {};
  const virtualModules: Record<string, unknown> = {};

  const piTuiPath = safeResolve("@earendil-works/pi-tui", require);
  const typeboxPath = safeResolve("typebox", require);
  const piNodeModules = findPiNodeModules();
  const piAgentCorePath = safeResolve(
    "@earendil-works/pi-agent-core",
    require,
    piNodeModules,
  );
  const piAiPath = safeResolve("@earendil-works/pi-ai", require, piNodeModules);

  const groups: Array<{
    specifiers: string[];
    target: string | undefined;
    stubWhenMissing: boolean;
  }> = [
    {
      specifiers: ["pi-tui", "@earendil-works/pi-tui", "@mariozechner/pi-tui"],
      target: piTuiPath,
      stubWhenMissing: false,
    },
    {
      specifiers: ["typebox", "@sinclair/typebox"],
      target: typeboxPath,
      stubWhenMissing: false,
    },
    {
      specifiers: [
        "pi-agent-core",
        "@earendil-works/pi-agent-core",
        "@mariozechner/pi-agent-core",
      ],
      target: piAgentCorePath,
      stubWhenMissing: true,
    },
    {
      specifiers: ["pi-ai", "@earendil-works/pi-ai", "@mariozechner/pi-ai"],
      target: piAiPath,
      stubWhenMissing: true,
    },
    {
      specifiers: [
        "@earendil-works/pi-coding-agent",
        "@mariozechner/pi-coding-agent",
      ],
      target: undefined,
      stubWhenMissing: true,
    },
  ];

  for (const { specifiers, target, stubWhenMissing } of groups) {
    for (const specifier of specifiers) {
      if (target) alias[specifier] = target;
      else if (stubWhenMissing) virtualModules[specifier] = {};
    }
  }

  return { alias, virtualModules };
}

function safeResolve(
  specifier: string,
  requireFn: NodeRequire,
  extraPaths?: string | undefined,
): string | undefined {
  try {
    if (extraPaths) {
      return requireFn.resolve(specifier, { paths: [extraPaths] });
    }
    return requireFn.resolve(specifier);
  } catch {
    return undefined;
  }
}

/** Compare release directory names by numeric segments, not lexically. */
export function compareVersionNames(a: string, b: string): number {
  const left = a.split(/[.-]/);
  const right = b.split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    const ln = Number(l);
    const rn = Number(r);
    if (l !== "" && r !== "" && Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn;
    } else {
      const lexical = l.localeCompare(r);
      if (lexical !== 0) return lexical;
    }
  }
  return 0;
}

function findPiNodeModules(): string | undefined {
  const base = join(homedir(), ".pi", "agent", "install", "releases");
  if (!existsSync(base)) return undefined;
  try {
    const releases = readdirSync(base)
      .filter((name) => existsSync(join(base, name, "node_modules")))
      .sort(compareVersionNames);
    if (releases.length === 0) return undefined;
    return join(base, releases[releases.length - 1], "node_modules");
  } catch {
    return undefined;
  }
}
