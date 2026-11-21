import type { ModelInfo, ThinkingLevelMap } from "../types.js";
import seed from "./model-catalog.seed.json" with { type: "json" };

export interface CatalogEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

const SEED: Record<string, CatalogEntry[]> = seed as Record<string, CatalogEntry[]>;

// Overlay entries fetched at runtime (remote catalog). Empty until loaded.
let overlay: Record<string, CatalogEntry[]> = {};

export function setRemoteOverlay(entries: Record<string, CatalogEntry[]>): void {
  overlay = entries ?? {};
}

export function clearRemoteOverlay(): void {
  overlay = {};
}

function mergedSeed(provider: string): CatalogEntry[] | undefined {
  const base = SEED[provider];
  const over = overlay[provider];
  if (!base && !over) return undefined;
  if (!over) return base;
  if (!base) return over;
  const byId = new Map<string, CatalogEntry>();
  for (const e of base) byId.set(e.id, e);
  for (const e of over) byId.set(e.id, e); // overlay wins
  return [...byId.values()];
}

export function catalogLookup(provider: string, model: string): CatalogEntry | undefined {
  const entries = mergedSeed(provider);
  if (!entries) return undefined;
  const exact = entries.find((e) => e.id === model);
  if (exact) return exact;
  return entries.find((e) => model.toLowerCase().startsWith(e.id.toLowerCase()));
}

export interface ResolveOptions {
  profileContextWindow?: number;
  override?: Partial<CatalogEntry>;
}

export function resolveModelCapabilities(
  provider: string,
  model: string,
  options: ResolveOptions = {},
): ModelInfo {
  const catalog = catalogLookup(provider, model);
  const override = options.override;
  const window =
    typeof options.profileContextWindow === "number" && options.profileContextWindow > 0
      ? options.profileContextWindow
      : typeof override?.contextWindow === "number" && override.contextWindow > 0
        ? override.contextWindow
        : typeof catalog?.contextWindow === "number" && catalog.contextWindow > 0
          ? catalog.contextWindow
          : undefined;
  const maxTokens =
    typeof override?.maxTokens === "number" && override.maxTokens > 0
      ? override.maxTokens
      : typeof catalog?.maxTokens === "number" && catalog.maxTokens > 0
        ? catalog.maxTokens
        : undefined;
  const reasoning =
    typeof override?.reasoning === "boolean"
      ? override.reasoning
      : catalog?.reasoning ?? false;
  const thinkingLevelMap =
    override?.thinkingLevelMap ?? catalog?.thinkingLevelMap;
  return {
    id: model,
    contextWindow: window,
    maxTokens,
    reasoning,
    thinkingLevelMap,
  };
}

// Upstream metadata mapping (used by the generator and tests).
export interface UpstreamModel {
  id: string;
  context_length?: number;
  context_window?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  supports_reasoning?: boolean;
  capabilities?: { reasoning?: boolean };
}

export function mapUpstreamModel(provider: string, upstream: UpstreamModel): CatalogEntry {
  const contextWindow =
    typeof upstream.context_length === "number" && upstream.context_length > 0
      ? upstream.context_length
      : typeof upstream.context_window === "number" && upstream.context_window > 0
        ? upstream.context_window
        : undefined;
  const maxTokens =
    typeof upstream.max_tokens === "number" && upstream.max_tokens > 0
      ? upstream.max_tokens
      : typeof upstream.max_output_tokens === "number" && upstream.max_output_tokens > 0
        ? upstream.max_output_tokens
        : undefined;
  const reasoning =
    upstream.reasoning === true ||
    upstream.supports_reasoning === true ||
    upstream.capabilities?.reasoning === true;
  return {
    id: upstream.id,
    contextWindow,
    maxTokens,
    reasoning,
    thinkingLevelMap: reasoning ? { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } : undefined,
  };
}