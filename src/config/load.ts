import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema, type Config } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { defaultUserConfigPath } from "./paths.js";

export interface LoadConfigOptions {
  userConfigPath?: string;
  projectRoot?: string;
  overrides?: Partial<Config>;
  /** Receives non-fatal configuration warnings (for example dropped keys). */
  onWarning?: (message: string) => void;
}

function defaultWarning(message: string): void {
  try {
    process.stderr.write(`atom-lite: ${message}\n`);
  } catch {
    // Diagnostics must never break startup.
  }
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
  if (process.env.ATOM_LITE_MODE) {
    out.runtime = { mode: process.env.ATOM_LITE_MODE };
  }
  return out as Partial<Config>;
}

function normalizeRuntime(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if ("approvalMode" in out && !("mode" in out)) {
    const legacy = out.approvalMode;
    out.mode =
      legacy === "trusted" ? "yolo" : legacy === "deny" ? "plan" : "plan";
  }
  delete out.approvalMode;
  // Removed caps: drop so strict schema does not reject older configs.
  delete out.maxIterations;
  delete out.maxToolCalls;
  delete out.maxExecutionMs;
  return out;
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

  // Normalize legacy runtime keys (approvalMode, removed caps) so older
  // configs keep loading.
  if (userRaw.runtime && typeof userRaw.runtime === "object") {
    userRaw.runtime = normalizeRuntime(userRaw.runtime as Record<string, unknown>);
  }
  if (projectRaw.runtime && typeof projectRaw.runtime === "object") {
    projectRaw.runtime = normalizeRuntime(projectRaw.runtime as Record<string, unknown>);
  }

  const warn = options.onWarning ?? defaultWarning;
  if (
    projectRaw.mcpServers &&
    typeof projectRaw.mcpServers === "object" &&
    Object.keys(projectRaw.mcpServers as object).length > 0
  ) {
    warn(
      "ignoring mcpServers from project config; MCP servers are user-config only",
    );
  }

  // Precedence (low -> high): defaults, user, project (allowed non-secret),
  // env, overrides. Security-critical user settings (approvalMode) are not
  // overridden by project config.
  const merged: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    ...userRaw,
    ...projectRaw,
    defaultProvider:
      (userRaw as any).defaultProvider ??
      (projectRaw as any).defaultProvider ??
      DEFAULT_CONFIG.defaultProvider,
    providers: {
      ...(DEFAULT_CONFIG.providers as Record<string, unknown>),
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
    // UI settings are user-owned: a repository must not change the user's
    // colours, mouse capture, or editor behaviour just by being opened.
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...((userRaw.ui as object) ?? {}),
    },
    // Extensions trust is user-owned.
    extensions: {
      trustedProjects: [
        ...((userRaw.extensions as { trustedProjects?: string[] })?.trustedProjects ??
          []),
      ],
      deniedProjects: [
        ...((userRaw.extensions as { deniedProjects?: string[] })?.deniedProjects ??
          []),
      ],
    },
    // MCP servers are user-owned: opening a repository must never launch a
    // process. Project entries are dropped above with a warning.
    mcpServers: {
      ...((userRaw.mcpServers as object) ?? {}),
    },
  };

  // Protect security-critical user settings from project override.
  const userRuntime =
    (userRaw.runtime as Record<string, unknown> | undefined) ?? {};
  const mergedRuntime = (merged.runtime as Record<string, unknown>) ?? {};
  mergedRuntime.mode = userRuntime.mode ?? "plan";
  mergedRuntime.maxTokensPerSession =
    userRuntime.maxTokensPerSession ?? null;
  mergedRuntime.maxTokensPerTurn = userRuntime.maxTokensPerTurn ?? null;
  delete mergedRuntime.approvalMode;
  merged.runtime = mergedRuntime;

  // no fallback; trust explicit configuration

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
