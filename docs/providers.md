# Providers

A provider profile names an endpoint, a model, and a credential source.

```jsonc title="~/.config/atom-lite/config.json"
{
  "defaultProvider": "ollama",
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b",
      "contextWindow": 131072,
      "keepAlive": "30m",
    },
  },
}
```

## Adapters

| `type`              | Adapter                   | Use with                                                                       |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `openai-compatible` | `OpenAICompatibleAdapter` | LM Studio, llama.cpp, Kilo, OpenAI, Anthropic, OpenRouter, Groq, Mistral, xAI. |
| `ollama`            | `OllamaAdapter`           | Native Ollama chat API.                                                        |
| `gemini`            | `GeminiAdapter`           | Official Gemini API.                                                           |

Every profile requires `type` and `model`. `baseUrl` defaults per adapter. A profile can also set `headers`, `options`, `think`, `keepAlive`, and `contextWindow`. See [Config](./config.md#providersname) for the full field table.

## Default provider

The built-in `kilo` profile points at `https://api.kilo.ai/api/gateway` with `kilo-auto/free`. It needs no key and is rate-limited for anonymous use. Override for one run:

```bash
atom-lite --provider ollama
atom-lite --model gemini-2.0-flash
atom-lite --provider openai --model gpt-4o-mini
```

## Interactive setup

`/provider` lists built-in providers. Selecting a hosted provider prompts for an API key with hidden input, validates it, and stores it in `~/.config/atom-lite/credentials.json` with `0600` permissions. `/model` opens a picker over every configured provider's models.

```text
/provider openai
/model openai/gpt-4o-mini
```

The selected provider and model persist to user config.

## Credentials

Lookup order for a profile:

1. The environment variable named by `apiKeyEnv`.
2. The stored credential in `credentials.json`.
3. Inline `apiKey`.

Prefer `apiKeyEnv` or the credentials file over inline keys. Never put secrets in project config or commit them. See [Safety](./safety.md).

## Context window

The status meter and compaction budget resolve the model window in this order:

1. `providers.<name>.contextWindow`.
2. Live provider metadata.
3. A built-in table of known model families.

Set `contextWindow` explicitly for local or custom models without metadata.
