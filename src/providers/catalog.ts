import type { Config } from "../config/schema.js";
import { loadCredentials } from "../config/credentials.js";
import { createProvider } from "./factory.js";
import { mergeHeaders, type HeaderMap } from "./http-headers.js";

export type ProviderType = "openai-compatible" | "ollama" | "gemini";

export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  type: ProviderType;
  baseUrl?: string;
  model: string;
  /** True when the provider needs an API key before it can be used. */
  requiresKey: boolean;
  /** Conventional environment variable for the key. */
  keyEnv?: string;
  /** Where a user can create a key. */
  keyUrl?: string;
  headers?: Record<string, string>;
  /** Shown before live model discovery completes (and as an offline fallback). */
  fallbackModels: string[];
  local?: boolean;
}

const GPT_FALLBACKS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "o4-mini",
  "o3",
];

const CLAUDE_FALLBACKS = [
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
];

const GEMINI_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
];

/**
 * Curated provider catalog. Hosted providers use the OpenAI-compatible adapter
 * (Anthropic exposes an OpenAI-compatible endpoint); Gemini uses its native
 * adapter; local runtimes are keyless.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "kilo",
    label: "Kilo Gateway",
    description: "Free hosted gateway (no key required)",
    type: "openai-compatible",
    baseUrl: "https://api.kilo.ai/api/gateway",
    model: "kilo-auto/free",
    requiresKey: false,
    fallbackModels: ["kilo-auto/free"],
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Official OpenAI API",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    requiresKey: true,
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    fallbackModels: GPT_FALLBACKS,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude via Anthropic's OpenAI-compatible endpoint",
    type: "openai-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    requiresKey: true,
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    headers: { "anthropic-version": "2023-06-01" },
    fallbackModels: CLAUDE_FALLBACKS,
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Official Gemini API",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    requiresKey: true,
    keyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey",
    fallbackModels: GEMINI_FALLBACKS,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Many hosted models through one key",
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    requiresKey: true,
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    fallbackModels: [
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    description: "Fast hosted inference",
    type: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    requiresKey: true,
    keyEnv: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    fallbackModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Official Mistral API",
    type: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    requiresKey: true,
    keyEnv: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys",
    fallbackModels: [
      "mistral-large-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
  },
  {
    id: "xai",
    label: "xAI",
    description: "Grok models",
    type: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-3-mini",
    requiresKey: true,
    keyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    fallbackModels: ["grok-3-mini", "grok-3", "grok-2-latest"],
  },
  {
    id: "ollama",
    label: "Ollama",
    description: "Local Ollama runtime",
    type: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:7b",
    requiresKey: false,
    local: true,
    fallbackModels: ["qwen2.5-coder:7b", "llama3.2:3b"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    description: "Local OpenAI-compatible server",
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    requiresKey: false,
    local: true,
    fallbackModels: ["local-model"],
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    description: "Local llama-server endpoint",
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "local-model",
    requiresKey: false,
    local: true,
    fallbackModels: ["local-model"],
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Build the provider profile stored in config from a preset, preserving any
 * model the user already chose.
 */
export function materializeProviderConfig(
  preset: ProviderPreset,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: preset.type,
    model: (existing?.model as string | undefined) ?? preset.model,
    apiKeyEnv: preset.keyEnv ?? null,
  };
  if (preset.baseUrl) out.baseUrl = existing?.baseUrl ?? preset.baseUrl;
  if (preset.headers) {
    out.headers = mergeHeaders(
      preset.headers,
      (existing?.headers as HeaderMap | undefined) ?? undefined,
    );
  }
  return out;
}

/**
 * Provider profiles that should appear in `/model`: explicitly configured
 * profiles, profiles with a stored credential, and presets whose key is in the
 * environment.
 */
export function availableProviderNames(
  config: Config,
  credentialsPath?: string,
): string[] {
  const names = new Set<string>();
  for (const [name, profile] of Object.entries(config.providers)) {
    if (profile && typeof profile === "object") names.add(name);
  }
  const creds = loadCredentials(credentialsPath);
  for (const name of Object.keys(creds.apiKeys)) {
    if (getPreset(name)) names.add(name);
  }
  for (const preset of PROVIDER_PRESETS) {
    if (preset.keyEnv && process.env[preset.keyEnv]) names.add(preset.id);
  }
  return [...names];
}

export function providerLabel(id: string): string {
  return getPreset(id)?.label ?? id;
}

/** Filter out models that clearly cannot be used for a chat/tool call. */
export function isLikelyChatModel(id: string): boolean {
  return !/embedding|embed-|whisper|tts|dall-e|moderation|imagen|veo|audio|realtime|transcribe/i.test(
    id,
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask a configured provider for its models. Failures are returned as an empty
 * list so callers can fall back to the configured model.
 */
export async function listModelsForProvider(
  config: Config,
  profile: string,
  timeoutMs = 8000,
): Promise<string[]> {
  try {
    const adapter = createProvider(config, profile) as any;
    if (typeof adapter.listModels !== "function") return [];
    const models = (await withTimeout(
      adapter.listModels(),
      timeoutMs,
    )) as string[];
    return models.filter(
      (m) => typeof m === "string" && m && isLikelyChatModel(m),
    );
  } catch {
    return [];
  }
}

export interface KeyProbeResult {
  ok: boolean;
  /** Authentication was explicitly rejected (401/403). */
  invalid: boolean;
  models: string[];
  error?: string;
}

/**
 * Validate an API key before persisting it. Reaches the provider's model list
 * endpoint directly so auth failures are visible (the adapters intentionally
 * swallow list errors and fall back to the configured model).
 */
export async function probeApiKey(
  preset: ProviderPreset,
  apiKey: string,
  timeoutMs = 10000,
): Promise<KeyProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (preset.type === "gemini") {
      const base = (
        preset.baseUrl ?? "https://generativelanguage.googleapis.com"
      ).replace(/\/$/, "");
      const res = await fetch(
        `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal: controller.signal },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          invalid: true,
          models: [],
          error: `HTTP ${res.status}`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          invalid: false,
          models: [],
          error: `HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as any;
      const models = (json.models ?? [])
        .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
        .filter((m: string) => m && isLikelyChatModel(m));
      return { ok: true, invalid: false, models };
    }

    const base = (preset.baseUrl ?? "").replace(/\/$/, "");
    const res = await fetch(`${base}/models`, {
      headers: mergeHeaders(
        { Authorization: `Bearer ${apiKey}` },
        preset.headers,
      ),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        invalid: true,
        models: [],
        error: `HTTP ${res.status}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        invalid: false,
        models: [],
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as any;
    const data = json.data ?? json.models ?? [];
    const models = data
      .map((m: any) => String(m.id ?? m.name ?? ""))
      .filter((m: string) => m && isLikelyChatModel(m));
    return { ok: true, invalid: false, models };
  } catch (err) {
    return {
      ok: false,
      invalid: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
