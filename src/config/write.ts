import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { defaultUserConfigPath } from "./paths.js";

export type RawUserConfig = Record<string, unknown>;

/** Read the user's raw config object without applying defaults or validation. */
export function readUserConfig(path = defaultUserConfigPath()): RawUserConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as RawUserConfig) : {};
  } catch {
    return {};
  }
}

/** Atomically write a raw user config object, creating the directory if needed. */
export function writeUserConfig(
  config: RawUserConfig,
  path = defaultUserConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Mutate the user config in place and persist the result. */
export function updateUserConfig(
  mutate: (config: RawUserConfig) => void,
  path = defaultUserConfigPath(),
): RawUserConfig {
  const config = readUserConfig(path);
  mutate(config);
  writeUserConfig(config, path);
  return config;
}

export interface SaveProviderOptions {
  defaultProvider?: string;
  path?: string;
  /**
   * Keep the selection in memory only. Extension-bridged providers are rebuilt
   * on every load, so persisting a model-only profile would leave a broken
   * provider behind once the extension is removed.
   */
  ephemeral?: boolean;
}

/**
 * Persist a provider profile selection. Existing user config (other providers,
 * runtime settings, etc.) is preserved. Ephemeral selections are not written.
 */
export function saveProviderSelection(
  profile: string,
  provider: Record<string, unknown>,
  opts: SaveProviderOptions = {},
): void {
  if (opts.ephemeral) return;
  updateUserConfig((config) => {
    const providers =
      config.providers && typeof config.providers === "object"
        ? (config.providers as Record<string, unknown>)
        : {};
    const existing =
      providers[profile] && typeof providers[profile] === "object"
        ? (providers[profile] as Record<string, unknown>)
        : {};
    providers[profile] = { ...existing, ...provider };
    config.providers = providers;
    if (opts.defaultProvider) config.defaultProvider = opts.defaultProvider;
  }, opts.path);
}

/** Persist the model chosen for a provider profile. */
export function saveProviderModel(
  profile: string,
  model: string,
  path = defaultUserConfigPath(),
): void {
  updateUserConfig((config) => {
    const providers =
      config.providers && typeof config.providers === "object"
        ? (config.providers as Record<string, unknown>)
        : {};
    const existing =
      providers[profile] && typeof providers[profile] === "object"
        ? (providers[profile] as Record<string, unknown>)
        : {};
    providers[profile] = { ...existing, model };
    config.providers = providers;
  }, path);
}

/** Persist the selected UI theme without touching other user settings. */
export function saveTheme(theme: string, path = defaultUserConfigPath()): void {
  updateUserConfig((config) => {
    const ui =
      config.ui && typeof config.ui === "object"
        ? (config.ui as Record<string, unknown>)
        : {};
    config.ui = { ...ui, theme };
  }, path);
}

/** Persist an MCP server's disabled state in the user config only. */
export function saveMcpDisabled(
  name: string,
  disabled: boolean,
  path = defaultUserConfigPath(),
): void {
  updateUserConfig((config) => {
    const servers =
      config.mcpServers && typeof config.mcpServers === "object"
        ? (config.mcpServers as Record<string, unknown>)
        : {};
    const existing =
      servers[name] && typeof servers[name] === "object"
        ? (servers[name] as Record<string, unknown>)
        : {};
    const next = { ...existing };
    delete next.disabled;
    servers[name] = { ...next, disable: disabled, enabled: !disabled };
    config.mcpServers = servers;
  }, path);
}
