# CLI

Run `atom-lite` in a project to open the full-screen terminal interface.

```text
atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID]
          [--list-sessions] [--search-sessions QUERY] [--no-tools] [--json]
          [--theme NAME] [--no-color] [--serve [PORT]] [--version] [--help]
```

## Flags

| Flag                      | Behavior                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `task`                    | One-shot task; the agent runs it and exits.                 |
| `--provider NAME`         | Select a provider profile.                                  |
| `--model MODEL`           | Override the model for this run.                            |
| `--continue`              | Resume the most recent session in this workspace.           |
| `--session ID`            | Resume a specific session.                                  |
| `--list-sessions`         | Print the session index and exit.                           |
| `--search-sessions QUERY` | Print matching sessions with snippets and exit.             |
| `--no-tools`              | Disable all tools; model-only chat.                         |
| `--json`                  | Non-interactive JSON output.                                |
| `--theme NAME`            | `auto`, `dark`, `light`, or `ansi` for this run.            |
| `--no-color`              | Force the no-colour theme.                                  |
| `--serve [PORT]`          | Serve the browser UI on localhost.                          |
| `--share`                 | With `--serve`, bind the UI on the LAN and print a QR code. |
| `--no-qr`                 | With `--share`, print the URL without a QR code.            |
| `--version`               | Print the version.                                          |
| `--help`                  | Print usage.                                                |

## Terminal interface

The prompt accepts plain tasks and slash commands. `/help` lists every command grouped by category; `ctrl+p` opens the fuzzy command palette.

| Key      | Action                                      |
| -------- | ------------------------------------------- |
| `Tab`    | Toggle `plan` / `yolo` mode.                |
| `Escape` | Cancel the active turn, or exit shell mode. |
| `ctrl+p` | Command palette.                            |
| `ctrl+o` | Toggle tool output expansion.               |
| `ctrl+b` | Jump to the transcript bottom.              |
| `ctrl+n` | New session.                                |
| `ctrl+f` | Search sessions.                            |
| `ctrl+t` | Toggle thinking display.                    |
| `ctrl+j` | Toggle the todo sidebar.                    |

Mouse wheel scrolling and click-to-focus work in interactive terminals. Set `ui.mouse` to `false` to disable them. All shortcuts are overridable in [Config](./config.md#keybindings).

While a question prompt is open, number keys and arrows select an option, `Space` toggles a multi-select, `Enter` confirms or submits, `Tab` and `Shift+Tab` move between questions, and `Escape` dismisses. Non-interactive runs cannot answer questions; the model receives an error and continues without asking.

## Modes

- `plan` allows built-in read-only tools and any tool that declares `readOnlyHint`, including MCP and extension tools.
- `yolo` allows every tool. `bash` still runs as a global exclusive barrier unless `runtime.bashConcurrency` is `parallel`.

The status line shows the active mode, persona, context usage, and open-todo count. When a goal or todos exist, the goal panel opens beside the transcript.

## Shell mode

Type `!` to enter shell mode. Every following line runs as a shell command until `Escape`. Prefix a single command with `! ` to run it without staying in shell mode.

## Non-interactive use

```bash
atom-lite --json "find unused exports" > result.json
```

Without a TTY, approval requests are denied rather than hanging. See [Safety](./safety.md).

## Next

- [Commands](./commands.md) — slash command reference.
- [Web UI](./web.md) — browser surface and share mode.
- [Troubleshooting](./troubleshooting.md) — common failures.
