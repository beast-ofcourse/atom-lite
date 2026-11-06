import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ExtensionSource = "cli" | "user" | "project" | "package";

export interface ExtensionManifest {
  name?: string;
  version?: string;
  extensions: string[];
  capabilities: string[];
  engines?: { "atom-lite"?: string };
  /** Which manifest field declared the extension entrypoints. */
  kind?: "pi" | "atom";
}

export interface DiscoveredExtension {
  id: string;
  source: ExtensionSource;
  /** Human-readable origin for diagnostics (for example "pi global"). */
  origin?: string;
  rootPath: string;
  entryPath: string;
  manifest?: ExtensionManifest;
  errors: string[];
  /** Project extensions are trusted only after an explicit project decision. */
  trusted: boolean;
  /** Set when the extension was discovered but must not be loaded. */
  skipReason?: string;
}

export interface DiscoverExtensionsOptions {
  cliPaths?: string[];
  /** Extra global extension directory (Atom-native). */
  userDir?: string;
  /** Extra project extension directory (Atom-native). */
  projectDir?: string;
  packageRoots?: string[];
  /** Workspace root. Enables project and settings discovery and trust checks. */
  cwd?: string;
  /** Pi agent directory (`~/.pi/agent` by default). */
  agentDir?: string;
  trustedProjects?: string[];
  deniedProjects?: string[];
}

const EXTENSION_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function extensionSuffix(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const suffix of EXTENSION_EXTENSIONS) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return undefined;
}

function isExtensionFile(path: string): boolean {
  return extensionSuffix(path) !== undefined;
}

function stripExtension(path: string): string {
  const suffix = extensionSuffix(path);
  return suffix ? path.slice(0, -suffix.length) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: unknown): {
  manifest?: ExtensionManifest;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { errors: ["package.json must be an object"] };
  }

  const pi = raw.pi;
  const atom = raw.atom;
  if (pi === undefined && atom === undefined) {
    return { errors: [] };
  }

  const errors: string[] = [];
  const field = pi !== undefined ? "pi" : "atom";
  const declaration = field === "pi" ? pi : atom;
  if (!isRecord(declaration)) {
    return { errors: [`"${field}" field must be an object`] };
  }

  const extensionsRaw = declaration.extensions;
  if (!Array.isArray(extensionsRaw) || extensionsRaw.length === 0) {
    errors.push(`"${field}.extensions" must be a non-empty array of strings`);
  }
  const extensions: string[] = [];
  if (Array.isArray(extensionsRaw)) {
    for (const entry of extensionsRaw) {
      if (typeof entry !== "string" || entry.trim() === "") {
        errors.push(`"${field}.extensions" entries must be non-empty strings`);
      } else {
        extensions.push(entry);
      }
    }
  }

  const capabilities: string[] = [];
  const capabilitiesRaw =
    declaration.capabilities ??
    (isRecord(atom) ? atom.capabilities : undefined);
  if (capabilitiesRaw !== undefined) {
    if (!Array.isArray(capabilitiesRaw)) {
      errors.push(`"${field}.capabilities" must be an array of strings`);
    } else {
      for (const capability of capabilitiesRaw) {
        if (typeof capability !== "string") {
          errors.push(`"${field}.capabilities" entries must be strings`);
        } else {
          capabilities.push(capability);
        }
      }
    }
  }

  let engines: ExtensionManifest["engines"];
  const enginesRaw = isRecord(atom) ? atom.engines : undefined;
  if (enginesRaw !== undefined) {
    if (!isRecord(enginesRaw)) {
      errors.push('"atom.engines" must be an object');
    } else if (
      enginesRaw["atom-lite"] !== undefined &&
      typeof enginesRaw["atom-lite"] !== "string"
    ) {
      errors.push('"atom.engines.atom-lite" must be a string');
    } else {
      engines = { "atom-lite": enginesRaw["atom-lite"] as string };
    }
  }

  if (errors.length > 0) return { errors };

  return {
    manifest: {
      name: typeof raw.name === "string" ? raw.name : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
      extensions,
      capabilities,
      engines,
      kind: field,
    },
    errors: [],
  };
}

function candidate(
  source: ExtensionSource,
  origin: string,
  rootPath: string,
  entryPath: string,
  manifest?: ExtensionManifest,
  errors: string[] = [],
): DiscoveredExtension {
  return {
    id: basename(rootPath).replace(/\.(ts|js|mjs)$/i, ""),
    source,
    origin,
    rootPath,
    entryPath: resolve(entryPath),
    manifest,
    errors,
    trusted: source !== "project",
  };
}

function packageCandidates(
  source: ExtensionSource,
  origin: string,
  packageDir: string,
): DiscoveredExtension[] | undefined {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const { manifest, errors } = parseManifest(readJson(packageJsonPath));
  if (errors.length > 0) {
    return [
      candidate(source, origin, packageDir, packageDir, undefined, errors),
    ];
  }
  if (!manifest) return undefined;
  return manifest.extensions.map((relativeEntry) => {
    const resolvedEntry = resolve(packageDir, relativeEntry);
    const missing = existsSync(resolvedEntry)
      ? []
      : [`extension entry does not exist: ${relativeEntry}`];
    return candidate(
      source,
      origin,
      packageDir,
      resolvedEntry,
      manifest,
      missing,
    );
  });
}

function indexEntry(dir: string): string | undefined {
  for (const name of ["index.ts", "index.js", "index.mjs"]) {
    const fullPath = join(dir, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return undefined;
}

function discoverDirectory(
  source: ExtensionSource,
  origin: string,
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
      out.push(candidate(source, origin, fullPath, fullPath));
      continue;
    }

    if (!entryStat.isDirectory()) continue;

    const packaged = packageCandidates(source, origin, fullPath);
    if (packaged !== undefined) {
      out.push(...packaged);
      continue;
    }

    const index = indexEntry(fullPath);
    if (index) out.push(candidate(source, origin, fullPath, index));
  }

  return out;
}

function discoverPath(
  source: ExtensionSource,
  origin: string,
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
    return [candidate(source, origin, inputPath, inputPath)];
  }
  if (stat.isDirectory()) {
    const packaged = packageCandidates(source, origin, inputPath);
    if (packaged !== undefined) return packaged;
    const index = indexEntry(inputPath);
    if (index) return [candidate(source, origin, inputPath, index)];
    return discoverDirectory(source, origin, inputPath);
  }
  return [];
}

function settingsExtensionPaths(settingsPath: string): string[] {
  const raw = readJson(settingsPath);
  if (!isRecord(raw)) return [];
  const extensions = raw.extensions;
  if (!Array.isArray(extensions)) return [];
  return extensions
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolve(dirname(settingsPath), entry));
}

function uniqueIds(entries: DiscoveredExtension[]): DiscoveredExtension[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = seen.get(entry.id) ?? 0;
    seen.set(entry.id, count + 1);
    if (count === 0) return entry;
    return {
      ...entry,
      id: `${entry.id}:${basename(stripExtension(entry.entryPath))}`,
    };
  });
}

export function discoverExtensions(
  options: DiscoverExtensionsOptions = {},
): DiscoveredExtension[] {
  const out: DiscoveredExtension[] = [];
  const cwd = options.cwd ? resolve(options.cwd) : undefined;

  for (const cliPath of options.cliPaths ?? []) {
    out.push(...discoverPath("cli", "cli", cliPath));
  }

  if (cwd) {
    out.push(
      ...discoverDirectory(
        "project",
        "pi project",
        join(cwd, ".pi", "extensions"),
      ),
    );
  }

  if (options.agentDir) {
    out.push(
      ...discoverDirectory(
        "user",
        "pi global",
        join(options.agentDir, "extensions"),
      ),
    );
  }

  // Settings entries come after extension directories so directory discovery
  // wins duplicate-resolution ties.
  if (options.agentDir) {
    for (const path of settingsExtensionPaths(
      join(options.agentDir, "settings.json"),
    )) {
      out.push(...discoverPath("user", "pi global settings", path));
    }
  }
  if (cwd) {
    for (const path of settingsExtensionPaths(
      join(cwd, ".pi", "settings.json"),
    )) {
      out.push(...discoverPath("project", "pi project settings", path));
    }
  }

  // Atom-native directories are the lowest-precedence discovery source.
  if (options.userDir) {
    out.push(...discoverDirectory("user", "atom global", options.userDir));
  }
  if (options.projectDir) {
    out.push(
      ...discoverDirectory("project", "atom project", options.projectDir),
    );
  }

  for (const root of options.packageRoots ?? []) {
    out.push(...discoverDirectory("package", "package", root));
  }

  const seen = new Set<string>();
  const deduped = out.filter((entry) => {
    const key = resolve(entry.entryPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const trustKey =
    cwd ?? (options.projectDir ? resolve(options.projectDir) : undefined);
  const trusted = new Set(
    (options.trustedProjects ?? []).map((path) => resolve(path)),
  );
  const denied = new Set(
    (options.deniedProjects ?? []).map((path) => resolve(path)),
  );

  const resolved = uniqueIds(deduped).map((entry) => {
    if (entry.source !== "project") {
      return { ...entry, trusted: true };
    }
    if (trustKey && denied.has(trustKey)) {
      return {
        ...entry,
        trusted: false,
        skipReason: "project extensions are denied",
      };
    }
    if (trustKey && trusted.has(trustKey)) {
      return { ...entry, trusted: true, skipReason: undefined };
    }
    return {
      ...entry,
      trusted: false,
      skipReason: "project is not trusted",
    };
  });

  return resolved;
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
          : extension.skipReason
            ? `skipped: ${extension.skipReason}`
            : "ok";
      const manifestName = extension.manifest?.name;
      const label = manifestName
        ? `${manifestName} (${extension.id})`
        : extension.id;
      return `${extension.source}\t${label}\t${extension.entryPath}\t${status}`;
    })
    .join("\n");
}
