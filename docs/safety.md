# Safety

Atom-lite keeps a small set of explicit boundaries. The model chooses tools; the runtime enforces these rules.

## Workspace boundary

`read`, `write`, and `edit` resolve paths against the workspace and reject escapes. Shell commands are not constrained by this boundary, so `bash` runs as a global exclusive barrier by default.

Outside-workspace file access and shell calls require approval in interactive mode. Non-interactive runs deny them rather than hanging.

## Modes

| Mode   | Allowed                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| `plan` | Built-in read-only tools and any tool declaring `readOnlyHint`, including MCP and extension tools. |
| `yolo` | Every tool. Default.                                                                               |

Toggle with Tab or set `runtime.mode`. Project config cannot change this field. See [Tools](./tools.md#plan-mode).

## Approvals

When approval is required, the TUI shows the exact command, working directory, timeout, and sandbox status. The choices are:

| Key | Choice        | Behavior                                         |
| --- | ------------- | ------------------------------------------------ |
| `y` | Approve       | Run this call only.                              |
| `n` | Deny          | Refuse this call.                                |
| `t` | Trust session | Allow this category for the rest of the session. |

Arrow keys plus Enter select a choice; Escape denies. The browser dialog has the same three choices. A pending approval is denied if a web tab drops and nobody reconnects within the grace period.

## Persona permissions

A primary persona can declare per-tool rules with `allow`, `ask`, and `deny`. An exact pattern beats a glob. `deny` blocks the call; `ask` routes it through the approval handler. See [Agent personas](./agents.md#permissions).

## Project trust

User, global, and CLI extensions load normally. Project-local extensions and personas are discovered but disabled until the project is approved. The first interactive run lists pending items in one prompt. The decision persists in `extensions.trustedProjects` or `extensions.deniedProjects` in user config. Use `/trust allow|deny|reset` to change it.

## Secrets

Interactive provider setup stores API keys in `~/.config/atom-lite/credentials.json` with `0600` permissions. Environment variables named by `apiKeyEnv` take precedence. Secrets are never written to project config, session files, or exported transcripts. See [Providers](./providers.md#credentials).

## Local-first

Atom-lite needs no cloud account, telemetry, or remote control plane. The optional browser surface binds `127.0.0.1`; share mode opens an outbound tunnel and keeps the local bind unchanged. See [Web UI](./web.md).

Reporting a vulnerability: follow [SECURITY.md](../SECURITY.md).
