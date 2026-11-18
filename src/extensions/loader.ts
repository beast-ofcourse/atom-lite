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
}

export class ExtensionLoader {
  private options: ExtensionLoaderOptions;
  private extensions: LoadedExtension[] = [];
  private discovered: DiscoveredExtension[] = [];
  private lifecycle: ExtensionLifecycleEvent[] = [];
  private jiti: ReturnType<typeof createJiti> | null = null;
  private generation = 0;
  private boundary: ExtensionBoundary;
  private readonly handlerTimeoutMs: number;

  constructor(options: ExtensionLoaderOptions = {}) {
    this.options = options;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 5_000;
    this.boundary = this.createBoundary();
  }

  private createBoundary(): ExtensionBoundary {
    return new ExtensionBoundary({
      generation: () => this.generation,
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
    const alias = buildAliasMap();
    const instance = createJiti(import.meta.url, {
      moduleCache: false,
      fsCache: false,
      alias,
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
    // Every load (including a reload) is a new generation. Handlers bound to
    // the previous generation become stale and can no longer mutate this set.
    this.generation++;
    this.boundary = this.createBoundary();
    const discovered = this.discover();
    // Extension state is built aside and only committed in one swap below.
    // A factory that throws must leave no registrations in the running host.
    const staged: LoadedExtension[] = [];

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
          "current",
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
        // Discard the staged registries: the error record gets a fresh,
        // empty staging record so it exposes zero registrations.
        const failure = this.createStaging(entry);
        await this.recordLifecycle(
          "extension_error",
          entry.id,
          message,
          failure.registries,
          failure.context,
        );
        staged.push({
          ...failure,
          status: "error",
          error: message,
          errorStack,
        });
      }
    }

    this.extensions = staged;
    return this.extensions;
  }

  private pushEvent(event: ExtensionLifecycleEvent): void {
    this.lifecycle.push(event);
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
  ): Promise<void> {
    const event: ExtensionLifecycleEvent = { type, extensionId, error };
    this.pushEvent(event);
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
            this.reportError({
              extensionId: event.extensionId,
              method: `on:${event.type}`,
              message: err.message,
              stack: err.stack,
              phase: "reject",
            });
          }),
      ),
    );
  }

  /** Record one contained failure so it is visible in doctor exactly once. */
  reportError(error: BoundaryError): void {
    this.pushEvent({
      type: "extension_error",
      extensionId: error.extensionId,
      error: error.message,
      method: error.method,
      stack: error.stack,
      phase: error.phase,
    });
  }

  /** Run an extension callback (e.g. a command) behind the current boundary. */
  runBounded<T>(
    meta: { extensionId: string; method: string },
    fn: () => T | Promise<T>,
    options?: { rethrow?: boolean },
  ): Promise<T | undefined> {
    return this.boundary.run(meta, fn, options);
  }

  list(): LoadedExtension[] {
    return [...this.extensions];
  }

  processedCount(): number {
    return this.extensions.filter((entry) => entry.status === "loaded").length;
  }

  lifecycleEvents(): ExtensionLifecycleEvent[] {
    return [...this.lifecycle];
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

function buildAliasMap(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const alias: Record<string, string> = {};

  const piTuiPath = safeResolve("@earendil-works/pi-tui", require);
  const typeboxPath = safeResolve("typebox", require);

  const piNodeModules = findPiNodeModules();
  const piAgentCorePath =
    safeResolve("@earendil-works/pi-agent-core", require, piNodeModules) ??
    shimPath("pi-agent-core");
  const piAiPath =
    safeResolve("@earendil-works/pi-ai", require, piNodeModules) ??
    shimPath("pi-ai");
  const piHostPath = shimPath("pi-host");

  const tuiTargets = piTuiPath ? [piTuiPath] : [];
  const typeboxTargets = typeboxPath ? [typeboxPath] : [];

  const pairs: Array<[string, string | undefined]> = [
    ["pi-tui", piTuiPath],
    ["@earendil-works/pi-tui", piTuiPath],
    ["@mariozechner/pi-tui", piTuiPath],
    ["typebox", typeboxPath],
    ["@sinclair/typebox", typeboxPath],
    ["pi-agent-core", piAgentCorePath],
    ["@earendil-works/pi-agent-core", piAgentCorePath],
    ["@mariozechner/pi-agent-core", piAgentCorePath],
    ["pi-ai", piAiPath],
    ["@earendil-works/pi-ai", piAiPath],
    ["@mariozechner/pi-ai", piAiPath],
    ["@earendil-works/pi-coding-agent", piHostPath],
    ["@mariozechner/pi-coding-agent", piHostPath],
  ];

  for (const [key, value] of pairs) {
    if (value) alias[key] = value;
  }

  // Ensure shims exist.
  ensureShim("pi-agent-core");
  ensureShim("pi-ai");
  ensureShim("pi-host");

  return alias;
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

function findPiNodeModules(): string | undefined {
  const candidates: string[] = [];
  const home = homedir();
  const base = join(home, ".pi", "agent", "install", "releases");
  if (existsSync(base)) {
    try {
      const releases = readdirSync(base)
        .map((name) => join(base, name, "node_modules"))
        .filter((dir) => existsSync(dir));
      // Pick the last (highest version) release directory.
      releases.sort();
      if (releases.length > 0) candidates.push(releases[releases.length - 1]);
    } catch {
      // ignore
    }
  }
  return candidates[0];
}

function shimDir(): string {
  return resolve(process.cwd(), "node_modules", ".atom-lite-shims");
}

function shimPath(name: string): string {
  return join(shimDir(), `${name}.js`);
}

function ensureShim(name: string): void {
  const dir = shimDir();
  try {
    if (!existsSync(dir)) {
      // create via fs
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // ignore
  }
  const file = shimPath(name);
  if (!existsSync(file)) {
    try {
      const { writeFileSync } = require("node:fs");
      writeFileSync(file, "module.exports = {};\n");
    } catch {
      // ignore
    }
  }
}
