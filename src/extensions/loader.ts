import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { discoverExtensions, type DiscoveredExtension } from "./discovery.js";
import { isProjectTrusted, normalizeProjectPath } from "./trust.js";
import { loadConfig } from "../config/load.js";
import { createExtensionAPI, createExtensionRegistries } from "./api.js";
import type { ExtensionContext, ExtensionStatus } from "./types.js";

export interface ExtensionLoaderOptions {
  cliPaths?: string[];
  userDir?: string;
  projectDir?: string;
  packageRoots?: string[];
  trustedProjects?: string[];
}

export interface LoadedExtension {
  id: string;
  source: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped";
  error?: string;
  registries: ReturnType<typeof createExtensionRegistries>;
}

export class ExtensionLoader {
  private options: ExtensionLoaderOptions;
  private extensions: LoadedExtension[] = [];

  constructor(options: ExtensionLoaderOptions = {}) {
    this.options = options;
  }

  private trustedProjectSet(): Set<string> {
    const projects =
      this.options.trustedProjects ??
      loadConfig().extensions?.trustedProjects ??
      [];
    return new Set(projects.map((project) => normalizeProjectPath(project)));
  }

  discover(): DiscoveredExtension[] {
    const trusted = this.trustedProjectSet();
    const projectExtDir = this.options.projectDir
      ? join(this.options.projectDir, ".atom-lite", "extensions")
      : undefined;
    const discovered = discoverExtensions({
      cliPaths: this.options.cliPaths,
      userDir: this.options.userDir,
      projectDir: projectExtDir,
      packageRoots: this.options.packageRoots,
    });
    return discovered.map((entry) => {
      if (
        entry.source === "project" &&
        !trusted.has(normalizeProjectPath(this.options.projectDir ?? process.cwd()))
      ) {
        return { ...entry, errors: [...entry.errors, "project is not trusted"] };
      }
      return entry;
    });
  }

  async loadAll(): Promise<LoadedExtension[]> {
    const discovered = this.discover();
    const loaded: LoadedExtension[] = [];

    for (const entry of discovered) {
      const registries = createExtensionRegistries();
      const trusted = this.trustedProjectSet();
      const ctx: ExtensionContext = {
        workspace: this.options.projectDir ?? process.cwd(),
        trusted:
          entry.source !== "project" ||
          trusted.has(normalizeProjectPath(this.options.projectDir ?? process.cwd())),
        log: (message) => {
          // eslint-disable-next-line no-console
          console.error(`[extension:${entry.id}] ${message}`);
        },
      };

      if (entry.errors.length > 0) {
        loaded.push({
          id: entry.id,
          source: entry.source,
          entryPath: entry.entryPath,
          status: "skipped",
          error: entry.errors.join("; "),
          registries,
        });
        continue;
      }

      if (entry.source === "project" && !this.trustedProjectSet().has(normalizeProjectPath(this.options.projectDir ?? process.cwd()))) {
        loaded.push({
          id: entry.id,
          source: entry.source,
          entryPath: entry.entryPath,
          status: "skipped",
          error: "project is not trusted",
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
          entryPath: entry.entryPath,
          status: "loaded",
          registries,
        });
      } catch (error) {
        loaded.push({
          id: entry.id,
          source: entry.source,
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

  async unloadAll(): Promise<void> {
    this.extensions = [];
  }
}
