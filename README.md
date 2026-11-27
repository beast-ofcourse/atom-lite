# Atom-lite

[![npm version](https://img.shields.io/npm/v/atom-lite?color=2c806b&logo=npm)](https://www.npmjs.com/package/atom-lite)
[![npm downloads](https://img.shields.io/npm/dm/atom-lite?color=2c806b&logo=npm)](https://www.npmjs.com/package/atom-lite)
[![npm total downloads](https://img.shields.io/badge/npm_total_downloads-6.2k-2c806b?logo=npm)](https://www.npmjs.com/package/atom-lite)
[![CI](https://github.com/beast-ofcourse/atom-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/beast-ofcourse/atom-lite/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/beast-ofcourse/atom-lite?color=2c806b)](./LICENSE)
[![node](https://img.shields.io/node/v/atom-lite?color=2c806b&logo=node.js)](https://nodejs.org)

A local-first, model-agnostic coding agent for the terminal. One agent loop, ten built-in tools, durable JSONL sessions, and explicit safety boundaries. No cloud account, telemetry, or control plane.

> **Note:** Atom-lite is not a fork of the Pi coding agent. Its agent harness is built from scratch and is unrelated to Pi.

```bash
npm install -g atom-lite
atom-lite "fix the failing test"
```

Requires Node.js >= 22.19.

## Install

```bash
npm install -g atom-lite
```

Run without installing:

```bash
npx atom-lite "explain this repository"
```

Other methods and the default provider are in [Install](./docs/install.md).

## Quick start

```bash
atom-lite                  # interactive session in the current directory
atom-lite "task"           # one-shot task, then exit
atom-lite --continue       # resume the most recent session here
atom-lite --serve          # browser UI on localhost
atom-lite --help
```

Pipe a task with stdin:

```bash
echo "summarize this repo" | atom-lite
```

See [Quick start](./docs/quickstart.md) and [CLI](./docs/cli.md).

## Features

- **One agent loop.** One conversation, one tool registry, one control loop. Parallelism lives inside a tool-call batch.
- **Ten built-in tools.** `read`, `write`, `edit`, `bash`, `grep`, `glob`, `webfetch`, `websearch`, `task`, `todo`.
- **Durable sessions.** Append-only JSONL event logs, resumable across restarts, grouped by workspace.
- **Context management.** Token estimation and compaction before the budget is exceeded; the full transcript stays on disk.
- **Autonomy modes.** `plan` for read-only work, `yolo` for all tools. Toggle with Tab.
- **Goal continuity.** A durable statement, success criteria, and a pause gate that survives compaction and session resume.
- **Local-first providers.** Ollama, Gemini, and any OpenAI-compatible endpoint, including local servers.
- **Browser surface.** `atom-lite --serve` drives the same runtime, tools, sessions, and approvals, with the session task ledger in a resizable side panel and selectable agent profiles. `--serve --share` binds on the LAN and prints a QR code for phone access.

The runtime validates tool arguments, enforces workspace boundaries, applies approval rules, and schedules calls safely. The model chooses the next step.

## Documentation

Start at the [documentation index](./docs/README.md).

| Topic                 | Page                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Install and providers | [Install](./docs/install.md) · [Providers](./docs/providers.md)                                                          |
| Daily use             | [Quick start](./docs/quickstart.md) · [CLI](./docs/cli.md) · [Commands](./docs/commands.md)                              |
| Configuration         | [Config](./docs/config.md)                                                                                               |
| Tools and safety      | [Tools](./docs/tools.md) · [Safety](./docs/safety.md)                                                                    |
| Sessions and goals    | [Sessions](./docs/sessions.md) · [Goals](./docs/goals.md)                                                                |
| Extensions            | [Agent personas](./docs/agents.md) · [Extensions](./docs/extensions.md) · [Extension test](./docs/cli.md#extension-test) |
| Surfaces              | [Web UI](./docs/web.md)                                                                                                  |
| Harness quality       | [Evals](./docs/eval.md)                                                                                                  |
| Help                  | [Troubleshooting](./docs/troubleshooting.md) · [Contributing](./CONTRIBUTING.md)                                         |

Architecture decision records are private to maintainers and are not published in this repository.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## License

MIT
