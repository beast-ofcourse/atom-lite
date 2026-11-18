import { compatibilityMatrix } from "./compatibility-matrix.js";

/** Tiers of the Pi-compatible `ExtensionAPI` surface. */
export type CompatibilityTier = 1 | 2 | 3;

/** The version of the `ExtensionAPI` surface exposed by this host. */
export const EXTENSION_API_VERSION = "1";

export interface ExtensionCompatibilityErrorOptions {
  /** Method (or registration site) that cannot be used. */
  method: string;
  /** Compatibility tier of the deferred API. Defaults to Tier 3. */
  tier?: CompatibilityTier;
  /** One-line reason the API is unavailable. */
  reason?: string;
  /** One-line replacement when one exists. */
  alternative?: string;
}

/**
 * Thrown by every deferred (Tier 3) API stub. It always names the method and
 * tier and, where one exists, suggests an alternative — so a caller gets a
 * diagnosable failure instead of a raw `TypeError` for a missing method.
 */
export class ExtensionCompatibilityError extends Error {
  readonly method: string;
  readonly tier: CompatibilityTier;
  readonly reason: string;
  readonly alternative?: string;

  constructor(options: ExtensionCompatibilityErrorOptions) {
    const tier = options.tier ?? 3;
    const reason = options.reason ?? "is not implemented in Atom-lite";
    const alternative = options.alternative;
    super(
      `Extension '${options.method}' is a tier ${tier} API and ${reason}` +
        (alternative ? `; use ${alternative} instead` : "") +
        ".",
    );
    this.name = "ExtensionCompatibilityError";
    this.method = options.method;
    this.tier = tier;
    this.reason = reason;
    if (alternative) this.alternative = alternative;
  }
}

/** Build a stub that always throws a Tier 3 compatibility error. */
export function tier3Stub(
  method: string,
  reason: string,
  alternative?: string,
): () => never {
  return () => {
    throw new ExtensionCompatibilityError({
      method,
      tier: 3,
      reason,
      alternative,
    });
  };
}

/**
 * True when `method` exists and is not a Tier 3 stub. Argument-level checks
 * (such as rejecting `exposure: "codemode"`) are separate and can still throw.
 */
export function methodSupported(method: string): boolean {
  const entry = compatibilityMatrix.find((row) => row.method === method);
  return entry !== undefined && entry.status !== "unsupported";
}
