import { join } from "node:path";
import { homedir } from "node:os";

/** Base directory for all user-level Atom-lite state. */
export function userConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "atom-lite");
}

export function defaultUserConfigPath(): string {
  return join(userConfigDir(), "config.json");
}

export function defaultCredentialsPath(): string {
  return join(userConfigDir(), "credentials.json");
}
