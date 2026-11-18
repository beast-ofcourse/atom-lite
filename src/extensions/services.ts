import { ExtensionCompatibilityError } from "./compatibility-error.js";

export interface ServiceRegistration {
  name: string;
  version: string;
  api: unknown;
  extensionId: string;
}

/** Shared across the extensions of one staged set; discarded on unload/reload. */
export type ServiceRegistry = Map<string, ServiceRegistration>;

export interface ServiceDeclarations {
  provides: string[];
  consumes: string[];
}

const QUOTED_NAME = /["']([^"']+)["']/;

/**
 * Find literal service names in an extension's source. This is only used to
 * order activation; the authoritative provide/consume call still validates the
 * real values at runtime. A name built dynamically simply has no ordering edge.
 */
export function scanServiceDeclarations(source: string): ServiceDeclarations {
  const provides: string[] = [];
  const consumes: string[] = [];
  for (const match of source.matchAll(/\.provide\(\s*([^,)]+)/g)) {
    const name = QUOTED_NAME.exec(match[1])?.[1];
    if (name) provides.push(name);
  }
  for (const match of source.matchAll(/\.consume\(\s*([^,)]+)/g)) {
    const name = QUOTED_NAME.exec(match[1])?.[1];
    if (name) consumes.push(name);
  }
  return { provides, consumes };
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string, method: string): SemVer {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][^-+]+)?$/.exec(value.trim());
  if (!match) {
    throw new ExtensionCompatibilityError({
      method,
      tier: 1,
      reason: `'${value}' is not a valid semver version`,
    });
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Minimal semver range support: `*`, `^`, `~`, `>=`, and exact x.y.z. */
export function satisfiesVersion(version: string, range: string): boolean {
  const actual = parseVersion(version, "provide");
  const spec = range.trim();
  if (spec === "" || spec === "*" || spec === "x") return true;
  if (spec.startsWith("^")) {
    const base = parseVersion(spec.slice(1), "consume");
    return actual.major === base.major && compare(actual, base) >= 0;
  }
  if (spec.startsWith("~")) {
    const base = parseVersion(spec.slice(1), "consume");
    return (
      actual.major === base.major &&
      actual.minor === base.minor &&
      compare(actual, base) >= 0
    );
  }
  if (spec.startsWith(">=")) {
    return compare(actual, parseVersion(spec.slice(2), "consume")) >= 0;
  }
  return compare(actual, parseVersion(spec, "consume")) === 0;
}

export function provideService(
  registry: ServiceRegistry,
  registration: ServiceRegistration,
): void {
  if (!registration.name || typeof registration.name !== "string") {
    throw new ExtensionCompatibilityError({
      method: "provide",
      tier: 1,
      reason: "a service name is required",
    });
  }
  parseVersion(registration.version, "provide");
  if (registry.has(registration.name)) {
    throw new ExtensionCompatibilityError({
      method: "provide",
      tier: 1,
      reason: `service '${registration.name}' is already provided by '${registry.get(registration.name)!.extensionId}'`,
    });
  }
  registry.set(registration.name, registration);
}

export function consumeService(
  registry: ServiceRegistry,
  name: string,
  range: string,
): unknown {
  const registration = registry.get(name);
  if (!registration) {
    throw new ExtensionCompatibilityError({
      method: "consume",
      tier: 1,
      reason: `service '${name}' is not provided by any loaded extension`,
    });
  }
  if (!satisfiesVersion(registration.version, range)) {
    throw new ExtensionCompatibilityError({
      method: "consume",
      tier: 1,
      reason: `service '${name}' version ${registration.version} does not satisfy '${range}'`,
    });
  }
  return registration.api;
}

export interface ServiceOrderResult<T> {
  /** Extensions in activation order: providers before their consumers. */
  order: T[];
  /** Ids that participate in a dependency cycle, if any. */
  cycle: string[];
}

/**
 * Stable topological sort over provide/consume edges. Ties keep discovery
 * order, so activation is deterministic. A dependency on an unknown service
 * adds no edge; the runtime `consume` call reports that as a typed error.
 */
export function orderByServices<T extends { id: string }>(
  extensions: T[],
  declarations: Map<string, ServiceDeclarations>,
): ServiceOrderResult<T> {
  const providerOf = new Map<string, string>();
  for (const extension of extensions) {
    for (const name of declarations.get(extension.id)?.provides ?? []) {
      if (!providerOf.has(name)) providerOf.set(name, extension.id);
    }
  }
  const dependencies = new Map<string, Set<string>>();
  for (const extension of extensions) {
    const deps = new Set<string>();
    for (const name of declarations.get(extension.id)?.consumes ?? []) {
      const provider = providerOf.get(name);
      if (provider && provider !== extension.id) deps.add(provider);
    }
    dependencies.set(extension.id, deps);
  }

  const remaining = [...extensions];
  const order: T[] = [];
  while (remaining.length > 0) {
    const next = remaining.findIndex((extension) => {
      const deps = dependencies.get(extension.id)!;
      return [...deps].every(
        (dep) => !remaining.some((other) => other.id === dep),
      );
    });
    if (next < 0) {
      return { order, cycle: remaining.map((extension) => extension.id) };
    }
    order.push(remaining.splice(next, 1)[0]);
  }
  return { order, cycle: [] };
}
