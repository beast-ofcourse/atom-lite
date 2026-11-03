import { readFileSync, existsSync } from "node:fs";
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

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const userPath = options.userConfigPath ?? defaultUserConfigPath();
  const projectPath = options.projectRoot
    ? join(options.projectRoot, ".atom-lite", "config.json")
    : join(process.cwd(), ".atom-lite", "config.json");

  const userRaw = readJsonFile(userPath) ?? {};
  const projectRaw = readJsonFile(projectPath) ?? {};

  // Project config must not override security-critical user settings; for the
  // skeleton we simply merge with user taking precedence over project, then
  // apply overrides (env/CLI) on top.
  const merged = {
    ...DEFAULT_CONFIG,
    ...projectRaw,
    ...userRaw,
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      ...(projectRaw as any).runtime,
      ...(userRaw as any).runtime,
    },
    context: {
      ...DEFAULT_CONFIG.context,
      ...(projectRaw as any).context,
      ...(userRaw as any).context,
    },
    sessions: {
      ...DEFAULT_CONFIG.sessions,
      ...(projectRaw as any).sessions,
      ...(userRaw as any).sessions,
    },
    providers: {
      ...((projectRaw as any).providers ?? {}),
      ...((userRaw as any).providers ?? {}),
    },
  };

  const parsed = ConfigSchema.safeParse({ ...merged, ...(options.overrides ?? {}) });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}