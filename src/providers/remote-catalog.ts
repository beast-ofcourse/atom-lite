import {
  setRemoteOverlay,
  clearRemoteOverlay,
  type CatalogEntry,
} from "./model-catalog.js";

const DEFAULT_URL = "https://pi.dev/api/models/providers";
const DEFAULT_REFRESH_MS = 4 * 60 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 4000;

let refreshTimer: NodeJS.Timeout | undefined;
let lastRefresh = 0;

function parseCatalog(value: unknown): Record<string, CatalogEntry[]> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, CatalogEntry[]> = {};
  for (const [provider, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const entries = Array.isArray(raw)
      ? raw
      : typeof raw === "object" &&
          raw !== null &&
          Array.isArray((raw as any).models)
        ? (raw as any).models
        : typeof raw === "object" && raw !== null
          ? Object.values(raw as Record<string, unknown>)
          : undefined;
    if (!Array.isArray(entries)) continue;
    const mapped: CatalogEntry[] = [];
    for (const e of entries) {
      if (!e || typeof e !== "object" || typeof (e as any).id !== "string")
        continue;
      const entry = e as Record<string, unknown>;
      mapped.push({
        id: String(entry.id),
        contextWindow:
          typeof entry.contextWindow === "number"
            ? entry.contextWindow
            : undefined,
        maxTokens:
          typeof entry.maxTokens === "number" ? entry.maxTokens : undefined,
        reasoning: entry.reasoning === true,
        thinkingLevelMap:
          (entry.thinkingLevelMap as CatalogEntry["thinkingLevelMap"]) ??
          undefined,
      });
    }
    if (mapped.length > 0) out[provider] = mapped;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function refreshRemoteCatalog(
  url: string = DEFAULT_URL,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const json = await res.json();
    const parsed = parseCatalog(json);
    if (!parsed) return false;
    setRemoteOverlay(parsed);
    lastRefresh = Date.now();
    return true;
  } catch {
    return false;
  }
}

export function startRemoteCatalogRefresh(
  url?: string,
  intervalMs: number = DEFAULT_REFRESH_MS,
): void {
  if (refreshTimer) return;
  // Initial best-effort refresh; failures are silent.
  void refreshRemoteCatalog(url);
  refreshTimer = setInterval(() => {
    void refreshRemoteCatalog(url);
  }, intervalMs);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

export function stopRemoteCatalogRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

export function getLastRefresh(): number {
  return lastRefresh;
}

export function _resetForTests(): void {
  clearRemoteOverlay();
  lastRefresh = 0;
  stopRemoteCatalogRefresh();
}
