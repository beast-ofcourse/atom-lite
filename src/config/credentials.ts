import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { defaultCredentialsPath } from "./paths.js";

export interface Credentials {
  /** Provider profile name -> raw API key. */
  apiKeys: Record<string, string>;
}

function emptyCredentials(): Credentials {
  return { apiKeys: {} };
}

/**
 * Load the user's credentials file. Missing or malformed files yield an empty
 * credential set so a broken file never blocks starting the CLI.
 */
export function loadCredentials(path = defaultCredentialsPath()): Credentials {
  if (!existsSync(path)) return emptyCredentials();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return emptyCredentials();
    const apiKeys = (raw as { apiKeys?: unknown }).apiKeys;
    if (!apiKeys || typeof apiKeys !== "object") return emptyCredentials();
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      apiKeys as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value) out[name] = value;
    }
    return { apiKeys: out };
  } catch {
    return emptyCredentials();
  }
}

function writeCredentials(creds: Credentials, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort (e.g., Windows filesystems without POSIX modes).
  }
}

/** Persist an API key for a provider profile with owner-only permissions. */
export function saveApiKey(
  profile: string,
  apiKey: string,
  path = defaultCredentialsPath(),
): void {
  const creds = loadCredentials(path);
  creds.apiKeys[profile] = apiKey.trim();
  writeCredentials(creds, path);
}

export function removeApiKey(
  profile: string,
  path = defaultCredentialsPath(),
): void {
  const creds = loadCredentials(path);
  delete creds.apiKeys[profile];
  writeCredentials(creds, path);
}

export function getApiKey(
  profile: string,
  path = defaultCredentialsPath(),
): string | null {
  return loadCredentials(path).apiKeys[profile] ?? null;
}

export function hasApiKey(
  profile: string,
  opts: { apiKeyEnv?: string | null; path?: string } = {},
): boolean {
  return resolveApiKey(profile, opts) !== null;
}

/**
 * Resolve a provider key using the same precedence as provider construction:
 * environment variable first, then the stored credential file.
 */
export function resolveApiKey(
  profile: string,
  opts: {
    apiKeyEnv?: string | null;
    inline?: string | null;
    path?: string;
  } = {},
): string | null {
  if (opts.apiKeyEnv) {
    const fromEnv = process.env[opts.apiKeyEnv];
    if (fromEnv) return fromEnv;
  }
  const stored = getApiKey(profile, opts.path);
  if (stored) return stored;
  return opts.inline ?? null;
}
