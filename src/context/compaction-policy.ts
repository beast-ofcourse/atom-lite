export type CompactionPolicy = "auto" | "summary" | "native";
export type ActiveCompactionStrategy = "summary" | "native";

export interface CompactionPolicyConfig {
  global?: CompactionPolicy;
  provider?: CompactionPolicy;
  models?: Record<string, { compactionStrategy?: CompactionPolicy }>;
}

/** Resolve the active strategy: model, then provider, then global. */
export function resolveCompactionPolicy(
  config: CompactionPolicyConfig,
  model: string,
  nativeCapable: boolean,
): ActiveCompactionStrategy {
  const explicit =
    config.models?.[model]?.compactionStrategy ??
    config.provider ??
    config.global ??
    "auto";
  if (explicit === "summary") return "summary";
  if (explicit === "native") return nativeCapable ? "native" : "summary";
  return nativeCapable ? "native" : "summary";
}
