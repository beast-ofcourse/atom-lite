# Atom-lite

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Atom-lite** is a local-first, model-agnostic coding agent with an intentionally small harness: one agent loop, exactly four built-in tools (`read`, `write`, `edit`, `bash`), a deterministic conflict-aware scheduler, durable JSONL sessions, and explicit safety boundaries. It runs against local or hosted model providers through interchangeable adapters — no cloud account, telemetry service, or hosted control plane required.

> Working title: *ThinAgent*. See [`project-overview.md`](./project-overview.md) for the full architecture blueprint, [`GLOSSARY.md`](./GLOSSARY.md) for domain vocabulary, and [`docs/adr/`](./docs/adr/) for architectural decisions.

---

## Table of contents

- [Why Atom-lite](#why-atom-lite)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Default provider](#default-provider)
- [Configuration](#configuration)
- [Usage](#usage)
- [Tools](#tools)
- [Providers](#providers)
- [Safety & security](#safety--security)
- [Sessions](#sessions)
- [Context management](#context-management)
- [Development](#development)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

## Why Atom-lite

Most coding agents accumulate tools, sub-agents, planning frameworks, retrieval pipelines, and orchestration layers until the harness itself becomes the product. Atom-lite takes the opposite stance:

- **Small core, strong primitives.** The core contains only a provider interface, a session model, a single agent loop, four tools, a scheduler/executor, context-window management, configuration, and a CLI.
- **The model decides; the runtime enforces.** The model chooses which tool to call and what to do next. The runtime validates arguments, enforces workspace boundaries, applies approval rules, schedules calls safely, and returns accurate results. There is no hard-coded "plan → inspect → edit → test" workflow.
- **Thin harness, not weak engineering.** Provider-specific formats, streaming failures, concurrent file access, shell timeouts, large outputs, context exhaustion, and session recovery are all handled — they are the reliability layer that makes a small harness useful.

## Features

- **Four general-purpose tools** — `read`, `write`, `edit`, `bash`. Everything else (search, tests, git, builds) goes through `bash`.
- **Single agent loop** — one agent, one conversation, one tool registry, one control loop. Parallelism lives inside a tool-call batch.
- **Conflict-aware scheduler** — per-file read/write locks and a global bash barrier. Parallelism is governed by resource conflicts, not applied blindly.
- **Durable sessions** — append-only JSONL event logs, resumable across CLI restarts, grouped by workspace.
- **Context management** — token estimation, compaction (summarization of older history) before the context budget is exceeded, while retaining the full transcript.
- **Live context meter** — the status line shows context tokens used against the selected model's real window (e.g. `tokens: 4.5k/256k`), resolved from provider metadata with known-model fallbacks.
- **Approval modes** — `ask` / `trusted` / `deny` for shell commands, with session-level trust.
- **Hash guards** — `expected_hash` rejects stale `write`/`edit` operations when the file changed since it was read.
- **Provider-agnostic** — Ollama, Gemini, and any OpenAI-compatible endpoint (LM Studio, llama.cpp, Kilo AI Gateway, OpenAI, Anthropic, OpenRouter, Groq, Mistral, xAI, …).
- **Interactive provider/model pickers** — `/provider` adds a provider and stores its key securely; `/model` fuzzy-searches every configured provider's models.
- **Local-first** — runs fully against local providers with no cloud account, telemetry, or hosted database.
- **Safe path handling** — file tools resolve against the workspace and reject escapes; shell is an explicit, sandbox-aware boundary.

## Install

```sh
npm install -g atom-lite
```

Or run without installing:

```sh
npx atom-lite "fix the failing test"
```

Requires **Node.js >= 22.19** (see `engines` in `package.json`).

## Quick start

```sh
atom-lite                 # interactive session in the current directory
atom-lite "task"          # run one task, then exit
atom-lite --provider NAME # select a provider profile
atom-lite --continue      # resume the most recent session
atom-lite --help
```

Pipe a task via stdin:

```sh
echo "summarize this repo" | atom-lite
```

## Default provider

Out of the box, Atom-lite uses the **Kilo AI Gateway** (`https://api.kilo.ai/api/gateway`) with the free `kilo-auto/free` model. No API key is required (rate-limited to 200 requests/hour per IP for anonymous use). Override via `--provider`/`--model` or config.

## Configuration

User config: `~/.config/atom-lite/config.json`
Project config: `.atom-lite/config.json` (non-secrets only)

Precedence (low → high): defaults → user config → project config (non-secret) → environment → CLI overrides. Security-critical user settings (e.g. `approvalMode`) are **not** overridable by project config.

Secrets are stored in `~/.config/atom-lite/credentials.json` with owner-only permissions (`0600`). Environment variables named by a provider's `apiKeyEnv` take precedence over the stored key. Secrets are never written to project config or session files.

Environment overrides:

| Variable | Effect |
| --- | --- |
| `ATOM_LITE_PROVIDER` | Default provider profile name |
| `ATOM_LITE_APPROVAL_MODE` | `ask` / `trusted` / `deny` |

Example `config.json`:

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
      "model": "qwen2.5-coder:7b"
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
    "maxIterations": 40,
    "maxToolCalls": 100
  },
  "context": {
    "maxInputTokens": null,
    "reserveOutputTokens": 4096,
    "compactAtPercent": 85
  }
}
```

See [`project-overview.md`](./project-overview.md) for the full configuration shape.

## Usage

```
atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID]
          [--no-tools] [--json] [--debug] [--version] [--help]
```

| Flag | Description |
| --- | --- |
| `task` | One-shot task; agent runs it and exits |
| `--provider NAME` | Select a provider profile |
| `--model MODEL` | Override the model for this run |
| `--continue` | Resume the most recent session in this workspace |
| `--session ID` | Resume a specific session |
| `--no-tools` | Disable all tools (model-only chat) |
| `--json` | Non-interactive JSON output |
| `--debug` | Debug logging |
| `--version` | Print version |
| `--help` | Show help |

## Tools

Exactly four built-in tools (see [ADR 0001](./docs/adr/0001-four-built-in-tools-only.md)):

| Tool | Purpose |
| --- | --- |
| `read` | Inspect files (with optional line ranges) |
| `write` | Create or replace files safely (hash-guarded) |
| `edit` | Precise find-and-replace edits (hash-guarded) |
| `bash` | Execute shell commands (global exclusive barrier by default) |

File discovery, search, tests, Git, builds, formatters, and package managers are available through `bash`, not through additional built-in tools.

## Providers

| Type | Adapter | Notes |
| --- | --- | --- |
| `openai-compatible` | `OpenAICompatibleAdapter` | LM Studio, llama.cpp/llama-server, Kilo AI Gateway, and other compatible endpoints |
| `ollama` | `OllamaAdapter` | Native Ollama chat API |
| `gemini` | `GeminiAdapter` | Official Gemini API |

Provider profiles are named combinations of endpoint, model, auth source, and options. Switching profiles mid-tool-exchange is disallowed.

### Interactive setup

- `/provider` opens a searchable list of built-in providers (Kilo, OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, xAI, Ollama, LM Studio, llama.cpp). Selecting a hosted provider prompts for an API key with hidden input, validates it against the provider, and saves it to `~/.config/atom-lite/credentials.json` (`0600`).
- `/model` opens a fuzzy-searchable picker containing models from **every configured provider** (plus providers whose key is present in the environment). Live model lists are fetched in the background while the picker stays responsive.
- `/model <provider>/<model>` and `/provider <name>` are the non-interactive forms.

The selected provider/model is persisted to the user config, so the next session starts where you left off.

## Safety & security

- **Workspace boundary** — `read`/`write`/`edit` resolve paths against the workspace and reject escapes. Shell commands are not constrained by this boundary (their effects are unknown), so `bash` runs as a global exclusive barrier.
- **Approval modes** — `ask` prompts before each shell command; `trusted` auto-approves; `deny` blocks. Session trust can be granted interactively (`t`).
- **Hash guards** — prevent stale overwrites when a file changed since it was read.
- **Sandboxing flags** — reported per command; see `src/security/`.
- **No secrets in config** — interactive provider setup stores API keys in `~/.config/atom-lite/credentials.json` with `0600` permissions; environment variables still take precedence.
- **Local-first** — no cloud account, telemetry, or remote control plane required (see [ADR 0004](./docs/adr/0004-local-first-no-cloud-dependency.md)).

## Sessions

Sessions are append-only JSONL event logs recording everything that happened in one conversation. They are resumable across CLI restarts and grouped by workspace. Stored under the session store (see `src/sessions/`). Compaction summarizes older history to stay within the context budget while retaining the full transcript.

## Context management

The context manager builds model input, estimates tokens, and triggers compaction before the context budget is exceeded. It also loads project instructions (e.g. `AGENTS.md`/`CLAUDE.md`-style files) subject to `maxProjectInstructionBytes`.

## Development

```sh
npm install
npm run dev        # run via tsx (src/cli/main.ts)
npm start          # build and run
npm run typecheck  # tsc --noEmit
npm test           # build + node --test
npm run build      # tsc
npm run format     # prettier --write .
```

Tests live in `tests/` (agent, config, runtime, tools). The project is TypeScript (strict) on NodeNext ESM.

## Architecture

```
src/
  agent/        # agent loop & types
  cli/          # terminal UI, approvals, commands
  config/       # schema, defaults, loader
  context/      # builder, manager, compaction, budget, instructions
  providers/    # adapters (openai-compatible, ollama, gemini, fake) + factory
  runtime/      # scheduler, approvals
  security/     # paths, process, redaction
  sessions/     # store, events, recovery
  tools/        # read, write, edit, bash, registry
```

Key design decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/):

- [0001 — Four built-in tools only](./docs/adr/0001-four-built-in-tools-only.md)
- [0002 — Single agent loop, no sub-agents in v1](./docs/adr/0002-single-agent-loop.md)
- [0003 — `bash` is a global exclusive barrier](./docs/adr/0003-bash-as-global-exclusive-barrier.md)
- [0004 — Local-first, no cloud dependency](./docs/adr/0004-local-first-no-cloud-dependency.md)
- [0005 — OpenTUI for the terminal UI](./docs/adr/0005-opentui-for-terminal-ui.md)

## Contributing

Issues and specs live as markdown under `.scratch/` (see [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md)). Domain vocabulary is in [`GLOSSARY.md`](./GLOSSARY.md). Please keep changes consistent with the "small core" principle: new tools require strong justification against ADR 0001.

## License

MIT
