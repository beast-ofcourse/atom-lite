import { ExtensionCompatibilityError } from "./compatibility-error.js";

/**
 * Declarative capability manifest. Every scope is opt-in: in `scoped` mode an
 * omitted scope is denied. Extensions that declare no manifest keep the old
 * `legacy-unscoped` behavior so they continue to work unchanged.
 */
export interface ScopeManifest {
  network?: { hosts?: string[] };
  exec?: { commands?: string[] };
  providers?: boolean;
  ui?: boolean;
  session?: { read?: boolean; write?: boolean };
}

/**
 * Scopes the runtime actually enforces. File access is not a scope: extensions
 * run in-process and are not sandboxed at the filesystem boundary, so claiming
 * `files.read`/`files.write` in a manifest would promise rights we cannot grant.
 */
export type ScopeName = "network" | "exec" | "providers" | "ui" | "session";

export type ScopeMode = "legacy-unscoped" | "scoped";

/** Default bound for `pi.exec`: 30 s per call, 10 MiB of captured output. */
export const EXTENSION_EXEC_TIMEOUT_MS = 30_000;
export const EXTENSION_EXEC_MAX_BUFFER = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(
  value: unknown,
  field: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`permissions ${field} must be an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`permissions ${field} entries must be non-empty strings`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Validate and normalize the `permissions` object from an extension manifest.
 * Unknown keys are ignored so future scopes can be declared without breaking
 * older hosts. A declared empty object is a scoped extension with no rights.
 */
export function parseScopeManifest(raw: unknown): {
  manifest?: ScopeManifest;
  errors: string[];
} {
  if (raw === undefined) return { errors: [] };
  if (!isRecord(raw)) {
    return { errors: ["permissions must be an object"] };
  }
  const errors: string[] = [];
  const manifest: ScopeManifest = {};

  if (raw.network !== undefined) {
    if (!isRecord(raw.network)) {
      errors.push("permissions network must be an object");
    } else {
      manifest.network = {
        hosts: stringList(raw.network.hosts, "network.hosts", errors),
      };
    }
  }
  if (raw.exec !== undefined) {
    if (!isRecord(raw.exec)) {
      errors.push("permissions exec must be an object");
    } else {
      manifest.exec = {
        commands: stringList(raw.exec.commands, "exec.commands", errors),
      };
    }
  }
  for (const key of ["providers", "ui"] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        errors.push(`permissions ${key} must be a boolean`);
      } else {
        manifest[key] = value;
      }
    }
  }
  if (raw.session !== undefined) {
    if (!isRecord(raw.session)) {
      errors.push("permissions session must be an object");
    } else {
      for (const key of ["read", "write"] as const) {
        const value = raw.session[key];
        if (value !== undefined) {
          if (typeof value !== "boolean") {
            errors.push(`permissions session.${key} must be a boolean`);
          } else {
            manifest.session = { ...manifest.session, [key]: value };
          }
        }
      }
    }
  }

  return errors.length > 0 ? { errors } : { manifest, errors: [] };
}

/** A declared manifest switches an extension from legacy to scoped mode. */
export function scopeModeForManifest(
  manifest: ScopeManifest | undefined | null,
): ScopeMode {
  return manifest ? "scoped" : "legacy-unscoped";
}

function hostMatches(host: string, allowed: string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    return (
      rule === lower || (rule.startsWith("*.") && lower.endsWith(rule.slice(1)))
    );
  });
}

/** Exact command or basename match against `exec.commands`. */
export function isCommandAllowed(
  manifest: ScopeManifest | undefined,
  command: string,
): boolean {
  if (!manifest) return true;
  const allowed = manifest.exec?.commands;
  if (!allowed) return false;
  const basename = command.split(/[\\/]/).pop() ?? command;
  return allowed.some((entry) => entry === command || entry === basename);
}

export function isHostAllowed(
  manifest: ScopeManifest | undefined,
  host: string,
): boolean {
  if (!manifest) return true;
  const allowed = manifest.network?.hosts;
  return allowed !== undefined && hostMatches(host, allowed);
}

export function isProviderAllowed(
  manifest: ScopeManifest | undefined,
): boolean {
  return !manifest || manifest.providers === true;
}

export function isUIAllowed(manifest: ScopeManifest | undefined): boolean {
  return !manifest || manifest.ui === true;
}

export function isSessionReadAllowed(
  manifest: ScopeManifest | undefined,
): boolean {
  return !manifest || manifest.session?.read === true;
}

export function isSessionWriteAllowed(
  manifest: ScopeManifest | undefined,
): boolean {
  return !manifest || manifest.session?.write === true;
}

/** Human-readable scopes for the trust prompt and `/extensions doctor`. */
export function describeScopes(manifest: ScopeManifest | undefined): string[] {
  if (!manifest) return ["legacy-unscoped (all scopes allowed)"];
  const out: string[] = [];
  const list = (values: string[] | undefined) =>
    values ? `[${values.join(", ")}]` : undefined;
  const hosts = list(manifest.network?.hosts);
  const commands = list(manifest.exec?.commands);
  if (hosts) out.push(`network: hosts ${hosts}`);
  if (commands) out.push(`exec: commands ${commands}`);
  if (manifest.providers) out.push("providers");
  if (manifest.ui) out.push("ui");
  if (manifest.session?.read) out.push("session: read");
  if (manifest.session?.write) out.push("session: write");
  return out;
}

/** Denials are typed and always name the scope the extension did not declare. */
export function scopeDeniedError(
  scope: ScopeName,
  method: string,
  detail?: string,
): ExtensionCompatibilityError {
  return new ExtensionCompatibilityError({
    method,
    tier: 1,
    reason: `denied by the '${scope}' scope` + (detail ? `: ${detail}` : ""),
  });
}
