import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export type ExtensionSource = "cli" | "user" | "project" | "package";

export interface ExtensionManifest {
  name?: string;
  version?: string;
  extensions: string[];
  capabilities: string[];
  engines?: { "atom-lite"?: string };
}

export interface DiscoveredExtension {
  id: string;
  source: ExtensionSource;
  rootPath: string;
  entryPath: string;
  manifest?: ExtensionManifest;
  errors: string[];
}

export interface DiscoverExtensionsOptions {
  cliPaths?: string[];
  userDir?: string;
  projectDir?: string;
  packageRoots?: string[];
}

const EXTENSION_EXTENSIONS = new Set([".js", ".mjs"]);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isExtensionFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".js") || lower.endsWith(".mjs");
}

function validateManifest(
  raw: unknown,
  packagePath: string,
): { manifest?: ExtensionManifest; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { errors: ["manifest must be an object"] };
  }
  const record = raw as Record<string, unknown>;
  const atom = record.atom;
  if (!atom || typeof atom !== "object") {
    return { errors: ["missing or invalid \"atom\" field"] };
  }
  const atomRecord = atom as Record<string, unknown>;
  const extensionsRaw = atomRecord.extensions;
  if (!Array.isArray(extensionsRaw) || extensionsRaw.length === 0) {
    errors.push("\"atom.extensions\" must be a non-empty array of strings");
  }
  const extensions: string[] = [];
  if (Array.isArray(extensionsRaw)) {
    for (const entry of extensionsRaw) {
      if (typeof entry !== "string" || entry.trim() === "") {
        errors.push("\"atom.extensions\" entries must be non-empty strings");
      } else {
        extensions.push(entry);
      }
    }
  }

  const capabilities: string[] = [];
  if (atomRecord.capabilities !== undefined) {
    if (!Array.isArray(atomRecord.capabilities)) {
      errors.push("\"atom.capabilities\" must be an array of strings");
    } else {
      for (const capability of atomRecord.capabilities) {
        if (typeof capability !== "string") {
          errors.push("\"atom.capabilities\" entries must be strings");
        } else {
          capabilities.push(capability);
        }
      }
    }
  }

  let engines: ExtensionManifest["engines"];
  if (atomRecord.engines !== undefined) {
    if (!atomRecord.engines || typeof atomRecord.engines !== "object") {
      errors.push("\"atom.engines\" must be an object");
    } else {
      const engineRecord = atomRecord.engines as Record<string, unknown>;
      if (
        engineRecord["atom-lite"] !== undefined &&
        typeof engineRecord["atom-lite"] !== "string"
      ) {
        errors.push("\"atom.engines.atom-lite\" must be a string");
      } else {
        engines = { "atom-lite": engineRecord["atom-lite"] as string };
      }
    }
  }

  if (errors.length > 0) return { errors };

  const manifest: ExtensionManifest = {
    name: typeof record.name === "string" ? record.name : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
    extensions,
    capabilities,
    engines,
  };
  return { manifest, errors: [] };
}

function candidate(
  source: ExtensionSource,
  rootPath: string,
  entryPath: string,
  manifest?: ExtensionManifest,
  errors: string[] = [],
): DiscoveredExtension {
  return {
    id: basename(rootPath).replace(/\.(js|mjs)$/i, ""),
    source,
    rootPath,
    entryPath: resolve(entryPath),
    manifest,
    errors,
  };
}

function discoverDirectory(
  source: ExtensionSource,
  dir: string,
): DiscoveredExtension[] {
  const out: DiscoveredExtension[] = [];
  if (!existsSync(dir)) return out;
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  entries.sort();

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let entryStat;
    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isFile() && isExtensionFile(fullPath)) {
      out.push(candidate(source, fullPath, fullPath));
      continue;
    }

    if (!entryStat.isDirectory()) continue;

    const packageJsonPath = join(fullPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const rawPackage = readJson(packageJsonPath);
      const { manifest, errors } = validateManifest(rawPackage, packageJsonPath);
      if (errors.length > 0) {
        out.push(candidate(source, fullPath, fullPath, undefined, errors));
        continue;
      }
      if (manifest) {
        for (const relativeEntry of manifest.extensions) {
          const resolvedEntry = resolve(fullPath, relativeEntry);
          if (!existsSync(resolvedEntry)) {
            out.push(
              candidate(source, fullPath, resolvedEntry, manifest, [
                `extension entry does not exist: ${relativeEntry}`,
              ]),
            );
          } else {
            out.push(candidate(source, fullPath, resolvedEntry, manifest));
          }
        }
        continue;
      }
    }

    const indexJs = join(fullPath, "index.js");
    const indexMjs = join(fullPath, "index.mjs");
    if (existsSync(indexJs)) {
      out.push(candidate(source, fullPath, indexJs));
    } else if (existsSync(indexMjs)) {
      out.push(candidate(source, fullPath, indexMjs));
    }
  }

  return out;
}

function discoverPath(
  source: ExtensionSource,
  inputPath: string,
): DiscoveredExtension[] {
  if (!existsSync(inputPath)) return [];
  let stat;
  try {
    stat = statSync(inputPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    if (!isExtensionFile(inputPath)) return [];
    return [candidate(source, inputPath, inputPath)];
  }
  if (stat.isDirectory()) {
    // A directory with a package manifest is treated as one package.
    const packageJsonPath = join(inputPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const rawPackage = readJson(packageJsonPath);
      const { manifest, errors } = validateManifest(rawPackage, packageJsonPath);
      if (errors.length > 0) {
        return [candidate(source, inputPath, inputPath, undefined, errors)];
      }
      if (manifest) {
        return manifest.extensions.map((relativeEntry) => {
          const resolvedEntry = resolve(inputPath, relativeEntry);
          const errors = existsSync(resolvedEntry)
            ? []
            : [`extension entry does not exist: ${relativeEntry}`];
          return candidate(source, inputPath, resolvedEntry, manifest, errors);
        });
      }
    }
    const indexJs = join(inputPath, "index.js");
    const indexMjs = join(inputPath, "index.mjs");
    if (existsSync(indexJs)) {
      return [candidate(source, inputPath, indexJs)];
    }
    if (existsSync(indexMjs)) {
      return [candidate(source, inputPath, indexMjs)];
    }
    return discoverDirectory(source, inputPath);
  }
  return [];
}

export function discoverExtensions(
  options: DiscoverExtensionsOptions = {},
): DiscoveredExtension[] {
  const out: DiscoveredExtension[] = [];

  for (const cliPath of options.cliPaths ?? []) {
    out.push(...discoverPath("cli", cliPath));
  }
  if (options.userDir) {
    out.push(...discoverDirectory("user", options.userDir));
  }
  if (options.projectDir) {
    out.push(...discoverDirectory("project", options.projectDir));
  }
  for (const root of options.packageRoots ?? []) {
    out.push(...discoverDirectory("package", root));
  }

  return out;
}

export function formatExtensionDiscovery(
  extensions: DiscoveredExtension[],
): string {
  if (extensions.length === 0) return "No extensions found.";
  return extensions
    .map((extension) => {
      const status =
        extension.errors.length > 0
          ? `invalid: ${extension.errors.join("; ")}`
          : "ok";
      const manifestName = extension.manifest?.name;
      const label = manifestName
        ? `${manifestName} (${extension.id})`
        : extension.id;
      return `${extension.source}\t${label}\t${extension.entryPath}\t${status}`;
    })
    .join("\n");
}
