import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigSchema, type Config } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";

export interface LoadConfigOptions {
  userConfigPath?: string;
  projectRoot?: string;
  overrides?: Partial<Config>;
}

function defaultUserConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "atom-lite", "config.json");
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid JSON in config file: ${path}`);
  }
}

function ensureUserConfig(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  } catch {
    // Best effort; ignore failures (e.g., read-only filesystem).
  }
}

function envOverrides(): Partial<Config> {
  const out: Record<string, unknown> = {};
  if (process.env.ATOM_LITE_PROVIDER)
    out.defaultProvider = process.env.ATOM_LITE_PROVIDER;
  if (process.env.ATOM_LITE_MODEL) {
    // model override applies to all providers is not precise; store as override hint only
  }
  if (process.env.ATOM_LITE_APPROVAL_MODE) {
    out.runtime = { approvalMode: process.env.ATOM_LITE_APPROVAL_MODE };
  }
  return out as Partial<Config>;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const userPath = options.userConfigPath ?? defaultUserConfigPath();
  const projectPath = options.projectRoot
    ? join(options.projectRoot, ".atom-lite", "config.json")
    : join(process.cwd(), ".atom-lite", "config.json");

  // Auto-create default user config on first run (never overwrite).
  if (options.userConfigPath === undefined) {
    ensureUserConfig(userPath);
  }

  const userRaw = (readJsonFile(userPath) ?? {}) as Record<string, unknown>;
  const projectRaw = (readJsonFile(projectPath) ?? {}) as Record<
    string,
    unknown
  >;

  // Precedence (low -> high): defaults, user, project (allowed non-secret),
  // env, overrides. Security-critical user settings (approvalMode) are not
  // overridden by project config.
  const merged: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    ...userRaw,
    ...projectRaw,
    providers: {
      ...((userRaw.providers as object) ?? {}),
      ...((projectRaw.providers as object) ?? {}),
    },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      ...((userRaw.runtime as object) ?? {}),
      ...((projectRaw.runtime as object) ?? {}),
    },
    context: {
      ...DEFAULT_CONFIG.context,
      ...((userRaw.context as object) ?? {}),
      ...((projectRaw.context as object) ?? {}),
    },
    sessions: {
      ...DEFAULT_CONFIG.sessions,
      ...((userRaw.sessions as object) ?? {}),
      ...((projectRaw.sessions as object) ?? {}),
    },
  };

  // Protect security-critical user settings from project override.
  const userRuntime =
    (userRaw.runtime as Record<string, unknown> | undefined) ?? {};
  const mergedRuntime = (merged.runtime as Record<string, unknown>) ?? {};
  if (userRuntime.approvalMode !== undefined) {
    mergedRuntime.approvalMode = userRuntime.approvalMode;
  }
  merged.runtime = mergedRuntime;

  const env = envOverrides();
  const mergedWithEnv = {
    ...merged,
    ...(env.defaultProvider ? { defaultProvider: env.defaultProvider } : {}),
    runtime: { ...(merged.runtime as object), ...(env.runtime ?? {}) },
  };
  const parsed = ConfigSchema.safeParse({
    ...mergedWithEnv,
    ...(options.overrides ?? {}),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
