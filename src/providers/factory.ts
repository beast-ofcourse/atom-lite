import type { Config } from "../config/schema.js";
import { resolveApiKey } from "../config/credentials.js";
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
    const apiKey = resolveApiKey(name, {
      apiKeyEnv: pcfg.apiKeyEnv,
      inline: pcfg.apiKey,
    });
    return new OpenAICompatibleAdapter({
      id: name,
      baseUrl: pcfg.baseUrl ?? "http://127.0.0.1:1234/v1",
      model: modelOverride ?? pcfg.model,
      apiKey,
      headers: pcfg.headers,
      contextWindow: pcfg.contextWindow,
    });
  }
  if (pcfg.type === "ollama") {
    return new OllamaAdapter({
      id: name,
      baseUrl: pcfg.baseUrl ?? "http://127.0.0.1:11434",
      model: modelOverride ?? pcfg.model,
      headers: pcfg.headers,
      keepAlive: pcfg.keepAlive,
      think: pcfg.think,
      options: pcfg.options,
      contextWindow: pcfg.contextWindow,
    });
  }
  if (pcfg.type === "gemini") {
    const apiKey = resolveApiKey(name, {
      apiKeyEnv: pcfg.apiKeyEnv,
      inline: pcfg.apiKey,
    });
    return new GeminiAdapter({
      id: name,
      baseUrl: pcfg.baseUrl,
      model: modelOverride ?? pcfg.model,
      apiKey,
      headers: pcfg.headers,
      contextWindow: pcfg.contextWindow,
    });
  }
  return new FakeProvider([
    { text: `Provider type ${pcfg.type} not implemented yet.` },
  ]);
}
