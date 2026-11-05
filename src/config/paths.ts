import { join } from "node:path";
import { homedir, platform } from "node:os";

/** Base directory for all user-level Atom-lite state. */
export function userConfigDir(): string {
  if (platform() === "win32") {
    const base =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "atom-lite");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "atom-lite");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "atom-lite");
}

export function defaultUserConfigPath(): string {
  return join(userConfigDir(), "config.json");
}

export function defaultCredentialsPath(): string {
  return join(userConfigDir(), "credentials.json");
}
