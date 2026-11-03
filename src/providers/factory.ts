import type { Config } from "../config/schema.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { OllamaAdapter } from "./ollama.js";
import { GeminiAdapter } from "./gemini.js";
import { FakeProvider } from "./fake.js";

export function createProvider(
  config: Config,
  profileName?: string,
  modelOverride?: string,
): any {
  const name = profileName ?? config.defaultProvider;
  const pcfg = (config.providers as Record<string, any>)[name];
  if (!pcfg)
    return new FakeProvider([{ text: "No provider configured; using fake." }]);
  if (pcfg.type === "openai-compatible") {
    const apiKey = pcfg.apiKeyEnv
      ? (process.env[pcfg.apiKeyEnv] ?? null)
      : null;
    return new OpenAICompatibleAdapter({
      id: name,
      baseUrl: pcfg.baseUrl ?? "http://127.0.0.1:1234/v1",
      model: modelOverride ?? pcfg.model,
      apiKey,
      headers: pcfg.headers,
    });
  }
  if (pcfg.type === "ollama") {
    return new OllamaAdapter({
      id: name,
      baseUrl: pcfg.baseUrl ?? "http://127.0.0.1:11434",
      model: modelOverride ?? pcfg.model,
      headers: pcfg.headers,
      keepAlive: pcfg.keepAlive,
      options: pcfg.options,
    });
  }
  if (pcfg.type === "gemini") {
    const apiKey = pcfg.apiKeyEnv
      ? (process.env[pcfg.apiKeyEnv] ?? null)
      : null;
    return new GeminiAdapter({
      id: name,
      baseUrl: pcfg.baseUrl,
      model: modelOverride ?? pcfg.model,
      apiKey,
      headers: pcfg.headers,
    });
  }
  return new FakeProvider([
    { text: `Provider type ${pcfg.type} not implemented yet.` },
  ]);
}
