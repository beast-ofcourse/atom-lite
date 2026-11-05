import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { discoverExtensions, type DiscoveredExtension } from "./discovery.js";
import { loadConfig } from "../config/load.js";
import { defaultAgentDir, userConfigDir } from "../config/paths.js";
import { createExtensionAPI, createExtensionRegistries } from "./api.js";
import type { ExtensionContext, ExtensionStatus } from "./types.js";

export interface ExtensionLoaderOptions {
  cliPaths?: string[];
  userDir?: string;
  /** Workspace root. Defaults to `projectDir`. */
  cwd?: string;
  /** Agent directory that owns Pi's global settings and extensions. */
  agentDir?: string;
  projectDir?: string;
  packageRoots?: string[];
  trustedProjects?: string[];
  deniedProjects?: string[];
}

export interface LoadedExtension {
  id: string;
  source: string;
  origin?: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped";
  error?: string;
  registries: ReturnType<typeof createExtensionRegistries>;
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

export class ExtensionLoader {
  private options: ExtensionLoaderOptions;
  private extensions: LoadedExtension[] = [];
  private discovered: DiscoveredExtension[] = [];

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

  async loadAll(): Promise<LoadedExtension[]> {
    const discovered = this.discover();
    const loaded: LoadedExtension[] = [];

    for (const entry of discovered) {
      const registries = createExtensionRegistries();
      const ctx: ExtensionContext = {
        workspace: this.workspace(),
        trusted: entry.trusted,
        log: (message) => {
          // eslint-disable-next-line no-console
          console.error(`[extension:${entry.id}] ${message}`);
        },
      };

      if (entry.errors.length > 0) {
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "skipped",
          error: entry.errors.join("; "),
          registries,
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
        });
        continue;
      }

      try {
        const moduleUrl = pathToFileURL(entry.entryPath).href;
        const imported = (await import(moduleUrl)) as {
          default?: (api: unknown) => unknown | Promise<unknown>;
          activate?: (api: unknown) => unknown | Promise<unknown>;
        };
        const factory = imported.default ?? imported.activate;
        if (typeof factory !== "function") {
          throw new Error("extension must export a default or activate function");
        }
        const api = createExtensionAPI(entry.id, ctx, registries, "current");
        await factory(api);
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "loaded",
          registries,
        });
      } catch (error) {
        loaded.push({
          id: entry.id,
          source: entry.source,
          origin: entry.origin,
          entryPath: entry.entryPath,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          registries,
        });
      }
    }

    this.extensions = loaded;
    return loaded;
  }

  list(): LoadedExtension[] {
    return [...this.extensions];
  }

  /** Discovery plus load state, including entries that never loaded. */
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

  async unloadAll(): Promise<void> {
    this.extensions = [];
  }
}
