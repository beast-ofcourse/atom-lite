import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { discoverExtensions, type DiscoveredExtension } from "./discovery.js";
import { loadConfig } from "../config/load.js";
import { defaultAgentDir, userConfigDir } from "../config/paths.js";
import { createExtensionAPI, createExtensionRegistries } from "./api.js";
import type { ExtensionContext } from "./types.js";
import type { AtomEvent } from "./types.js";

export interface ExtensionLoaderOptions {
  cliPaths?: string[];
  userDir?: string;
  cwd?: string;
  agentDir?: string;
  projectDir?: string;
  packageRoots?: string[];
  trustedProjects?: string[];
  deniedProjects?: string[];
  onLifecycleEvent?: (event: {
    type: AtomEvent;
    extensionId: string;
    error?: string;
  }) => void;
}

export interface LoadedExtension {
  id: string;
  source: string;
  origin?: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped";
  error?: string;
  registries: ReturnType<typeof createExtensionRegistries>;
  context?: ExtensionContext;
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
}

export class ExtensionLoader {
  private options: ExtensionLoaderOptions;
  private extensions: LoadedExtension[] = [];
  private discovered: DiscoveredExtension[] = [];
  private lifecycle: ExtensionLifecycleEvent[] = [];
  private jiti: ReturnType<typeof createJiti> | null = null;

  constructor(options: ExtensionLoaderOptions = {}) {
    this.options = options;
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
        this.options.deniedProjects ??
        config.extensions?.deniedProjects ??
        [],
    };
  }

  discover(): DiscoveredExtension[] {
    const cwd = this.workspace();
    const decisions = this.decisions();
    const discovered = discoverExtensions({
      cliPaths: this.options.cliPaths,
      cwd,
      agentDir: this.options.agentDir ?? defaultAgentDir(),
      userDir:
        this.options.userDir ?? join(userConfigDir(), "extensions"),
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

  async loadAll(): Promise<LoadedExtension[]> {
    const discovered = this.discover();
    const loaded: LoadedExtension[] = [];

    for (const entry of discovered) {
      const registries = createExtensionRegistries();
      const ctx: ExtensionContext = {
        workspace: this.workspace(),
        trusted: entry.trusted,
        log: (message) => {
          console.error(`[extension:${entry.id}] ${message}`);
        },
      };

      if (entry.errors.length > 0) {
        const error = entry.errors.join("; ");
        this.recordLifecycle("extension_error", entry.id, error);
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "skipped",
          error,
          registries,
          context: ctx,
        });
        continue;
      }

      if (entry.skipReason) {
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "skipped",
          error: entry.skipReason,
          registries,
          context: ctx,
        });
        continue;
      }

      try {
        const jiti = this.getJiti();
        const imported = (await jiti.import(entry.entryPath, {
          default: true,
        })) as unknown;
        // jiti.import with default:true returns default export or module.
        const moduleExports =
          imported && typeof imported === "object"
            ? (imported as Record<string, unknown>)
            : {};
        // Re-import full module to access named exports.
        const fullModule = (await jiti.import(entry.entryPath)) as Record<
          string,
          unknown
        >;
        const factory =
          (typeof fullModule?.default === "function"
            ? fullModule.default
            : undefined) ??
          (typeof fullModule?.activate === "function"
            ? fullModule.activate
            : undefined) ??
          (typeof moduleExports === "function" ? moduleExports : undefined);

        if (typeof factory !== "function") {
          throw new Error(
            "extension must export a default or activate function",
          );
        }

        const api = createExtensionAPI(
          entry.id,
          ctx,
          registries,
          "current",
        );
        await factory(api);
        this.emitToRegistries(registries, ctx, "extension_load", entry.id);
        this.recordLifecycle("extension_load", entry.id);
        this.emitToRegistries(registries, ctx, "extension_activate", entry.id);
        this.recordLifecycle("extension_activate", entry.id);
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "loaded",
          registries,
          context: ctx,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.emitToRegistries(registries, ctx, "extension_error", entry.id, message);
        this.recordLifecycle("extension_error", entry.id, message);
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "error",
          error: message,
          registries,
          context: ctx,
        });
      }
    }

    this.extensions = loaded;
    return loaded;
  }

  private recordLifecycle(
    type: AtomEvent,
    extensionId: string,
    error?: string,
  ): void {
    const event: ExtensionLifecycleEvent = { type, extensionId, error };
    this.lifecycle.push(event);
    this.options.onLifecycleEvent?.({ type, extensionId, error });
    // Invoke handlers registered by already-loaded extensions.
    for (const loaded of this.extensions) {
      const handlers = loaded.registries.handlers.get(type);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          void handler({ type, extensionId, error }, loaded.context!);
        } catch {
          // Handler failures must not break loading.
        }
      }
    }
  }

  private emitToRegistries(
    registries: ReturnType<typeof createExtensionRegistries>,
    ctx: ExtensionContext,
    type: AtomEvent,
    extensionId: string,
    error?: string,
  ): void {
    const handlers = registries.handlers.get(type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        void handler({ type, extensionId, error }, ctx);
      } catch {
        // Handler failures must not break loading.
      }
    }
  }

  list(): LoadedExtension[] {
    return [...this.extensions];
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
        error:
          loaded?.error ?? (entry.errors.join("; ") || entry.skipReason),
        trusted: entry.trusted,
        toolCount: loaded?.registries.tools.size ?? 0,
        commandCount: loaded?.registries.commands.size ?? 0,
      };
    });
  }

  doctor(): string {
    if (this.discovered.length === 0) this.discover();
    if (this.extensions.length === 0) {
      // Ensure load state is available.
    }
    const loadedByPath = new Map(
      this.extensions.map((entry) => [entry.entryPath, entry]),
    );
    const lines: string[] = [];
    for (const entry of this.discovered) {
      const loaded = loadedByPath.get(entry.entryPath);
      const status = loaded?.status ?? (entry.skipReason ? "skipped" : "discovered");
      const error = loaded?.error ?? (entry.errors.join("; ") || entry.skipReason);
      const counts = loaded
        ? `${loaded.registries.tools.size} tools, ${loaded.registries.commands.size} commands, ${loaded.registries.handlers.size} event types`
        : "not loaded";
      lines.push(
        `${entry.id}\t${entry.source}${entry.origin ? `:${entry.origin}` : ""}\t${entry.manifest?.version ?? "-"}\t${status}\t${counts}\t${entry.entryPath}${error ? `\t${error}` : ""}`,
      );
    }
    return lines.join("\n") || "No extensions discovered.";
  }

  async unloadAll(): Promise<void> {
    for (const loaded of this.extensions) {
      this.recordLifecycle("extension_unload", loaded.id);
    }
    this.extensions = [];
    this.jiti = null;
  }
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
