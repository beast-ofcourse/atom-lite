# Configuration reference

Atom-lite is configured with JSON files and a small set of environment
variables. Provider API keys can live in a separate credentials file.

## Files

| Scope       | Path                                                       | Notes                                                            |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| User        | `${XDG_CONFIG_HOME:-~/.config}/atom-lite/config.json`      | Auto-created with defaults on first run. Never overwritten.      |
| Project     | `<workspace>/.atom-lite/config.json`                       | Intended for non-secret, per-repository settings.                |
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
project config does not replace the whole section. Deliberate exceptions:
**`runtime.mode`, `runtime.maxTokensPerSession`, `runtime.maxTokensPerTurn`,
`runtime.agent`, and the whole `ui` section are read only from user config or the
environment**, so a repository cannot silently relax safety settings, select an
agent persona, or change your colours and editor behaviour.

## Top level

| Key               | Type   | Default        | Description                                     |
| ----------------- | ------ | -------------- | ----------------------------------------------- |
| `defaultProvider` | string | `"kilo"`       | Profile used when `--provider` is omitted.      |
| `providers`       | object | `kilo` profile | Named provider profiles.                        |
| `runtime`         | object | see below      | Loop, scheduler, and execution limits.          |
| `context`         | object | see below      | Context budget and compaction.                  |
| `sessions`        | object | see below      | Session persistence.                            |
| `lsp`             | object | see below      | Optional language server integration.           |
| `ui`              | object | see below      | Theme and editor preferences. User config only. |
| `keybindings`     | object | see below      | Keyboard shortcut overrides.                    |
| `mcpServers`      | object | `{}`           | Stdio MCP server definitions. User config only. |
| `extensions`      | object | see below      | Extension trust settings. User config only.     |

## `providers.<name>`

A profile is a named endpoint plus model and credentials.

| Key             | Type              | Default           | Description                                                                                                              |
| --------------- | ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `type`          | string            | required          | `openai-compatible`, `ollama`, or `gemini`.                                                                              |
| `model`         | string            | required          | Model id. `--model` overrides it for one run.                                                                            |
| `baseUrl`       | URL string        | adapter-specific  | `http://127.0.0.1:1234/v1` for OpenAI-compatible, `http://127.0.0.1:11434` for Ollama, provider default for Gemini.      |
| `apiKeyEnv`     | string \| null    | none              | Environment variable that holds the key.                                                                                 |
| `apiKey`        | string \| null    | none              | Inline key. Prefer `apiKeyEnv` or the credentials file.                                                                  |
| `headers`       | object of strings | none              | Extra HTTP headers.                                                                                                      |
| `contextWindow` | positive integer  | provider metadata | Explicit context window for models without metadata. Highest-priority source for the status meter and compaction budget. |
| `keepAlive`     | string            | adapter default   | Ollama only: how long the model stays loaded.                                                                            |
| `think`         | boolean \| string | adapter default   | Ollama only: forwarded as the `think` option for reasoning models.                                                       |
| `options`       | object            | none              | Ollama only: request options merged into every call (for example sampling settings).                                     |

Credential lookup order for a profile: `apiKeyEnv` environment variable, then the
stored credential, then inline `apiKey`.

## `runtime`

| Key                    | Type                       | Default    | Description                                                                                                                                                                                                |
| ---------------------- | -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxParallelToolCalls` | positive integer           | `10`       | Concurrency cap for a tool-call batch.                                                                                                                                                                     |
| `maxToolOutputBytes`   | positive integer           | `30000`    | Output cap per tool result.                                                                                                                                                                                |
| `maxBashTimeMs`        | positive integer           | `120000`   | Timeout for a single `bash` call (2 minutes).                                                                                                                                                              |
| `bashConcurrency`      | `"serial"` \| `"parallel"` | `"serial"` | `serial` keeps `bash` as a global exclusive barrier.                                                                                                                                                       |
| `mode`                 | `"plan"` \| `"yolo"`       | `"yolo"`   | `plan` allows read-only tools (built-in read-only tools and any tool declaring `readOnlyHint`, including MCP/extension tools); `yolo` allows all tools without approval. User config and environment only. |
| `agent`                | string                     | unset      | Default primary persona name applied at startup. User config only. See [Agent personas](./agents.md).                                                                                                      |
| `maxTokensPerSession`  | positive integer \| null   | `null`     | Optional session token budget (hard stop). `null` means no limit. User config only.                                                                                                                        |
| `maxTokensPerTurn`     | positive integer \| null   | `null`     | Optional per-turn token soft warning. `null` means no warning. User config only.                                                                                                                           |
| `checkpointing`        | boolean                    | (ignored)  | Deprecated: automatic checkpoints were removed. Accepted for config compatibility; no effect.                                                                                                              |

## `context`

| Key                          | Type                     | Default | Description                                                 |
| ---------------------------- | ------------------------ | ------- | ----------------------------------------------------------- |
| `maxInputTokens`             | positive integer \| null | `null`  | Input budget. `null` derives it from the model window.      |
| `reserveOutputTokens`        | positive integer         | `4096`  | Headroom kept for the response.                             |
| `compactAtPercent`           | integer 1–100            | `85`    | Context usage that triggers compaction.                     |
| `maxProjectInstructionBytes` | positive integer         | `30000` | Cap on injected `AGENTS.md`/`CLAUDE.md`-style instructions. |
| `compactEveryNTurns`         | integer >= 0             | `0`     | Compact every N turns. `0` disables periodic compaction.    |

The model window is resolved from, in order: `providers.<name>.contextWindow`,
live provider metadata, then a built-in table of known model families.

## `sessions`

| Key             | Type                     | Default | Description                                               |
| --------------- | ------------------------ | ------- | --------------------------------------------------------- |
| `enabled`       | boolean                  | `true`  | Persist sessions as JSONL.                                |
| `retentionDays` | positive integer \| null | `null`  | Delete sessions older than this. `null` keeps everything. |

## `ui`

`ui` is user-owned. Project config may include the section, but it is ignored.

| Key            | Type    | Default  | Description                                                                              |
| -------------- | ------- | -------- | ---------------------------------------------------------------------------------------- |
| `theme`        | string  | `"auto"` | `auto`, `dark`, `light`, or `ansi` (no colour). Persisted by `/theme`.                   |
| `mouse`        | boolean | `true`   | Capture mouse events for wheel scrolling and click-to-focus in interactive TTY sessions. |
| `vimMode`      | boolean | `false`  | Reserved for the optional modal editor.                                                  |
| `showThinking` | boolean | `true`   | Initial thinking display; `/thinking` toggles it for the session.                        |

`auto` uses the terminal's colour-scheme report when available, then
`COLORFGBG`, then falls back to `dark`. `--no-color` and a non-empty `NO_COLOR`
environment variable force the `ansi` theme. The transcript, status line,
banner, and pickers read semantic tokens rather than hardcoded escapes.

## Recovery

Automatic pre-mutation checkpoints were removed (see
[ADR 0018](./adr/0018-defer-checkpoint-removal.md)); use git for undo and
review, and `/diff` for working-tree changes.

- `/diff [--stat] [path]` — show workspace changes against git `HEAD` (added,
  modified, and untracked files). Requires a git repository.

Legacy checkpoint data on disk is no longer used. Orphaned capture
directories (left by terminated workers) are purged automatically at every
startup; the rest can be removed with:

```sh
rm -rf ~/.config/atom-lite/checkpoints
```

## `keybindings`

Keyboard shortcut overrides. All fields are nullable; set a field to `null` to disable its shortcut.

| Key                | Type           | Default       | Description              |
| ------------------ | -------------- | ------------- | ------------------------ |
| `jumpBottom`       | string or null | `"ctrl+b"`    | Jump to bottom.          |
| `newSession`       | string or null | `"ctrl+n"`    | Start a new session.     |
| `searchSessions`   | string or null | `"ctrl+f"`    | Search sessions.         |
| `scrollUp`         | string or null | `"ctrl+up"`   | Scroll up.               |
| `scrollDown`       | string or null | `"ctrl+down"` | Scroll down.             |
| `toggleThinking`   | string or null | `"ctrl+t"`    | Toggle thinking display. |
| `inputHistoryUp`   | string or null | `"up"`        | Previous input history.  |
| `inputHistoryDown` | string or null | `"down"`      | Next input history.      |

### Editor keybindings (fixed)

The prompt editor always supports: `ctrl+backspace` deletes the word left of
the cursor, `ctrl+shift+backspace` deletes the whole current line. Terminals
without Kitty keyboard-protocol support use the legacy defaults `ctrl+w` /
`alt+backspace` (word) and `ctrl+u` (line start) instead.

## `mcpServers`

User-owned only. Project config entries are ignored with a warning. Each entry
declares a stdio MCP server.

| Key                | Type     | Default     | Description                                               |
| ------------------ | -------- | ----------- | --------------------------------------------------------- |
| `command`          | string   | required    | Executable to launch.                                     |
| `args`             | string[] | `[]`        | Arguments passed to the command.                          |
| `env`              | object   | `{}`        | Environment variables added to the minimal inherited set. |
| `cwd`              | string   | process cwd | Working directory for the server.                         |
| `enabled`          | boolean  | `true`      | Whether the server may be connected.                      |
| `requiresApproval` | boolean  | `false`     | Route every tool call through approval.                   |
| `startupTimeoutMs` | number   | `10000`     | Handshake timeout.                                        |
| `callTimeoutMs`    | number   | `60000`     | Per-call timeout.                                         |

Server processes inherit a minimal environment (`PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TMPDIR`, and platform equivalents) plus declared `env`. Provider API
keys are not inherited unless declared. Tools appear as `mcp__<server>__<tool>`.

## `extensions`

User-owned trust settings for extensions.

| Key               | Type     | Default | Description                                                    |
| ----------------- | -------- | ------- | -------------------------------------------------------------- |
| `trustedProjects` | string[] | `[]`    | Absolute project paths whose local extensions may load.        |
| `deniedProjects`  | string[] | `[]`    | Absolute project paths whose local extensions must never load. |

Project-local extensions are discovered but disabled until their project is
listed here. User, global, and CLI extensions load without this setting.

| Variable                | Effect                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `ATOM_LITE_PROVIDER`    | Selects the default provider profile.                          |
| `ATOM_LITE_MODE`        | Sets `runtime.mode`.                                           |
| `NO_COLOR`              | Forces the no-colour (`ansi`) theme when non-empty.            |
| `COLORFGBG`             | Falls back to this value to detect a light or dark background. |
| Any name in `apiKeyEnv` | Supplies that provider's API key.                              |

## `lsp`

Optional, off by default. When enabled, Atom-lite lazily spawns language servers
per workspace root and exposes `lsp_diagnostics`, `lsp_definition`,
`lsp_references`, and `lsp_symbols` tools. Built-in presets activate
automatically when their server binary is installed (TypeScript/JavaScript,
Python via pyright, Go, Rust).

| Key       | Type    | Default | Description                                                   |
| --------- | ------- | ------- | ------------------------------------------------------------- |
| `enabled` | boolean | `false` | Turn LSP on.                                                  |
| `servers` | object  | `{}`    | Custom or override server definitions (same fields as below). |

Each entry in `servers`:

| Key              | Type     | Default  | Description                                                      |
| ---------------- | -------- | -------- | ---------------------------------------------------------------- |
| `command`        | string   | required | Executable to launch.                                            |
| `args`           | string[] | `[]`     | Arguments (for example `["--stdio"]`).                           |
| `extensions`     | string[] | `[]`     | File extensions handled by this server.                          |
| `rootMarkers`    | string[] | `[]`     | Files that identify a project root (for example `package.json`). |
| `initialization` | object   | `{}`     | LSP `initializationOptions`.                                     |
| `disabled`       | boolean  | `false`  | Disable a built-in preset by id (for example `typescript`).      |

To enable LSP, set in user or project config:

```json
{ "lsp": { "enabled": true } }
```

Then install at least one language server, for example:

```bash
npm install -g typescript-language-server typescript
```

LSP tools appear only when `lsp.enabled` is true. No server is started until a
relevant file is touched.

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
    "mode": "plan",
    "bashConcurrency": "serial",
    "maxParallelToolCalls": 10
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
