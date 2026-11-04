# Configuration reference

Atom-lite is configured with JSON files and a small set of environment
variables. Provider API keys can live in a separate credentials file.

## Files

| Scope | Path | Notes |
| --- | --- | --- |
| User | `${XDG_CONFIG_HOME:-~/.config}/atom-lite/config.json` | Auto-created with defaults on first run. Never overwritten. |
| Project | `<workspace>/.atom-lite/config.json` | Intended for non-secret, per-repository settings. |
| Credentials | `${XDG_CONFIG_HOME:-~/.config}/atom-lite/credentials.json` | Written by `/provider` with `0600` permissions. Never commit it. |

Malformed JSON fails with `Invalid JSON in config file: <path>`. Unknown keys are
rejected by the strict schema; validation errors name the offending path.

## Precedence

Low to high:

1. Built-in defaults
2. User config
3. Project config
4. Environment variables
5. CLI and API overrides

Objects (`providers`, `runtime`, `context`, `sessions`) merge key by key; a
project config does not replace the whole section. Two deliberate exceptions:
**`runtime.approvalMode` and the whole `ui` section are read only from user config
or the environment**, so a repository cannot silently switch a trusted setup into
auto-approval or change your colours and editor behaviour.

## Top level

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | string | `"kilo"` | Profile used when `--provider` is omitted. |
| `providers` | object | `kilo` profile | Named provider profiles. |
| `runtime` | object | see below | Loop, scheduler, and execution limits. |
| `context` | object | see below | Context budget and compaction. |
| `sessions` | object | see below | Session persistence. |
| `ui` | object | see below | Theme and editor preferences. User config only. |

## `providers.<name>`

A profile is a named endpoint plus model and credentials.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | required | `openai-compatible`, `ollama`, or `gemini`. |
| `model` | string | required | Model id. `--model` overrides it for one run. |
| `baseUrl` | URL string | adapter-specific | `http://127.0.0.1:1234/v1` for OpenAI-compatible, `http://127.0.0.1:11434` for Ollama, provider default for Gemini. |
| `apiKeyEnv` | string \| null | none | Environment variable that holds the key. |
| `apiKey` | string \| null | none | Inline key. Prefer `apiKeyEnv` or the credentials file. |
| `headers` | object of strings | none | Extra HTTP headers. |
| `contextWindow` | positive integer | provider metadata | Explicit context window for models without metadata. Highest-priority source for the status meter and compaction budget. |
| `keepAlive` | string | adapter default | Ollama only: how long the model stays loaded. |
| `think` | boolean \| string | adapter default | Ollama only: forwarded as the `think` option for reasoning models. |
| `options` | object | none | Ollama only: request options merged into every call (for example sampling settings). |

Credential lookup order for a profile: `apiKeyEnv` environment variable, then the
stored credential, then inline `apiKey`.

## `runtime`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxIterations` | positive integer | `40` | Agent-loop turns per run. |
| `maxToolCalls` | positive integer | `100` | Tool calls allowed per run. |
| `maxExecutionMs` | positive integer | `1800000` | Wall-clock limit per run (30 minutes). |
| `maxParallelToolCalls` | positive integer | `4` | Concurrency cap for a tool-call batch. |
| `maxToolOutputBytes` | positive integer | `30000` | Output cap per tool result. |
| `maxBashTimeMs` | positive integer | `120000` | Timeout for a single `bash` call (2 minutes). |
| `bashConcurrency` | `"serial"` \| `"parallel"` | `"serial"` | `serial` keeps `bash` as a global exclusive barrier. |
| `approvalMode` | `"ask"` \| `"trusted"` \| `"deny"` | `"ask"` | Shell-command approval policy. User config and environment only. |

## `context`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxInputTokens` | positive integer \| null | `null` | Input budget. `null` derives it from the model window. |
| `reserveOutputTokens` | positive integer | `4096` | Headroom kept for the response. |
| `compactAtPercent` | integer 1–100 | `85` | Context usage that triggers compaction. |
| `maxProjectInstructionBytes` | positive integer | `30000` | Cap on injected `AGENTS.md`/`CLAUDE.md`-style instructions. |

The model window is resolved from, in order: `providers.<name>.contextWindow`,
live provider metadata, then a built-in table of known model families.

## `sessions`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Persist sessions as JSONL. |
| `retentionDays` | positive integer \| null | `null` | Delete sessions older than this. `null` keeps everything. |

## `ui`

`ui` is user-owned. Project config may include the section, but it is ignored.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | string | `"auto"` | `auto`, `dark`, `light`, or `ansi` (no colour). Persisted by `/theme`. |
| `mouse` | boolean | `true` | Capture mouse events for wheel scrolling and click-to-focus in interactive TTY sessions. |
| `vimMode` | boolean | `false` | Reserved for the optional modal editor. |
| `showThinking` | boolean | `true` | Initial thinking display; `/thinking` toggles it for the session. |

`auto` uses the terminal's colour-scheme report when available, then
`COLORFGBG`, then falls back to `dark`. `--no-color` and a non-empty `NO_COLOR`
environment variable force the `ansi` theme. The transcript, status line,
banner, and pickers read semantic tokens rather than hardcoded escapes.

## `mcpServers`

User-owned only. Project config entries are ignored with a warning. Each entry
declares a stdio MCP server.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | string | required | Executable to launch. |
| `args` | string[] | `[]` | Arguments passed to the command. |
| `env` | object | `{}` | Environment variables added to the minimal inherited set. |
| `cwd` | string | process cwd | Working directory for the server. |
| `enabled` | boolean | `true` | Whether the server may be connected. |
| `requiresApproval` | boolean | `false` | Route every tool call through approval. |
| `startupTimeoutMs` | number | `10000` | Handshake timeout. |
| `callTimeoutMs` | number | `60000` | Per-call timeout. |

Server processes inherit a minimal environment (`PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TMPDIR`, and platform equivalents) plus declared `env`. Provider API
keys are not inherited unless declared. Tools appear as `mcp__<server>__<tool>`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ATOM_LITE_PROVIDER` | Selects the default provider profile. |
| `ATOM_LITE_APPROVAL_MODE` | Sets `runtime.approvalMode`. |
| `NO_COLOR` | Forces the no-colour (`ansi`) theme when non-empty. |
| `COLORFGBG` | Falls back to this value to detect a light or dark background. |
| Any name in `apiKeyEnv` | Supplies that provider's API key. |

## Example

```json
{
  "defaultProvider": "kilo",
  "providers": {
    "kilo": {
      "type": "openai-compatible",
      "baseUrl": "https://api.kilo.ai/api/gateway",
      "model": "kilo-auto/free",
      "apiKeyEnv": null
    },
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b",
      "contextWindow": 131072,
      "keepAlive": "30m"
    },
    "gemini": {
      "type": "gemini",
      "model": "gemini-2.0-flash",
      "apiKeyEnv": "GEMINI_API_KEY"
    }
  },
  "runtime": {
    "approvalMode": "ask",
    "bashConcurrency": "serial",
    "maxToolCalls": 100
  },
  "context": {
    "compactAtPercent": 85,
    "reserveOutputTokens": 4096
  },
  "sessions": {
    "enabled": true,
    "retentionDays": 30
  },
  "ui": {
    "theme": "auto"
  }
}
```

Project config can be a smaller subset; defaults fill the rest:

```json
{
  "runtime": {
    "maxToolOutputBytes": 50000
  },
  "context": {
    "maxProjectInstructionBytes": 60000
  }
}
```
