import type { ModelInfo, ThinkingLevelMap } from "../types.js";
import { knownContextWindow } from "./context-window.js";

export interface CatalogEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

const SEED: Record<string, CatalogEntry[]> = {
  openai: [
    { id: "gpt-4o", contextWindow: 128000, maxTokens: 16384, reasoning: false },
    { id: "gpt-4o-mini", contextWindow: 128000, maxTokens: 16384, reasoning: false },
    { id: "gpt-4.1", contextWindow: 1047576, maxTokens: 32768, reasoning: false },
    { id: "gpt-5", contextWindow: 1050000, maxTokens: 128000, reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
    { id: "o1", contextWindow: 200000, maxTokens: 100000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
    { id: "o3", contextWindow: 200000, maxTokens: 100000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
    { id: "o4-mini", contextWindow: 200000, maxTokens: 100000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
  ],
  anthropic: [
    { id: "claude-3-5-sonnet", contextWindow: 200000, maxTokens: 8192, reasoning: false },
    { id: "claude-sonnet-4", contextWindow: 200000, maxTokens: 64000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
    { id: "claude-opus-4", contextWindow: 200000, maxTokens: 32000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  ],
  google: [
    { id: "gemini-1.5-pro", contextWindow: 2097152, maxTokens: 8192, reasoning: false },
    { id: "gemini-2.0-flash", contextWindow: 1048576, maxTokens: 8192, reasoning: false },
    { id: "gemini-2.5-pro", contextWindow: 1048576, maxTokens: 65536, reasoning: true, thinkingLevelMap: { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH", xhigh: null, max: null } },
  ],
};

export function catalogLookup(provider: string, model: string): CatalogEntry | undefined {
  const entries = SEED[provider];
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
          : knownContextWindow(model);
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
