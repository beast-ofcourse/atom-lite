# Commands

Type `/help` in the prompt to list every command grouped by category. `ctrl+p` opens the fuzzy command palette.

```text
/goal set Ship the login fix
/sessions all
/compact focus on the auth refactor
```

## General

| Command                 | Behavior                                 |
| ----------------------- | ---------------------------------------- |
| `/help` (alias `/?`)    | Show the grouped command list.           |
| `/doctor`               | Run diagnostics.                         |
| `/keybindings`          | Open the keybindings config file.        |
| `/shortcuts`            | List configured shortcuts.               |
| `/thinking`             | Toggle thinking display for the session. |
| `/exit` (alias `/quit`) | Exit the TUI.                            |

## Model

| Command               | Behavior                                     |
| --------------------- | -------------------------------------------- |
| `/model [model]`      | Fuzzy picker, or switch directly to `model`. |
| `/provider [profile]` | Add or select a provider profile.            |
| `/thinking [level]`   | Set the thinking level, or open a picker.    |
| `/effort [level]`     | Alias for `/thinking`.                       |

`/model <provider>/<model>` selects a model from a specific provider. Selections persist to user config. See [Providers](./providers.md).

`/thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The picker and completion list only the levels the selected model supports; a requested level is clamped to the nearest supported one. On a model without reasoning, the command reports that thinking is unsupported. The chosen level applies from the next turn and persists as that model's default.

## Agent

| Command              | Behavior                            |
| -------------------- | ----------------------------------- |
| `/agents`            | List primary agent personas.        |
| `/agent [name]`      | Open a picker, or switch to `name`. |
| `/goal [subcommand]` | Read or control the session goal.   |

Bare `/goal` prints the statement, criteria, status, and open-todo count.

| Subcommand            | Example                                      |
| --------------------- | -------------------------------------------- |
| `set`                 | `/goal set Ship the login fix`               |
| `criteria`            | `/goal criteria tests pass; docs updated`    |
| `constraints`         | `/goal constraints no new dependencies`      |
| `pause` / `resume`    | `/goal pause`                                |
| `clear`               | `/goal clear`                                |
| `complete [evidence]` | `/goal complete tests pass and docs updated` |
| `status`              | `/goal status`                               |

Criteria may span multiple lines. Statement and criteria are user-owned; the model can only read them and mark the goal complete with evidence. See [Goals](./goals.md).

## Session

| Command                                                      | Behavior                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `/rename [rename <title>]` (alias `/session`)                | Show session info or set the title.                           |
| `/sessions [all]`                                            | Resume a session from this workspace, or from all workspaces. |
| `/search <query>`                                            | Print matching sessions with snippets.                        |
| `/new` (alias `/clear`)                                      | Start a new session.                                          |
| `/compact [focus]`                                           | Compact older context now.                                    |
| `/diff [--stat] [path]`                                      | Show workspace changes against git `HEAD`.                    |
| `/export [path] [--format md\|json] [--force] [--no-redact]` | Export the transcript.                                        |
| `/usage`                                                     | Show token and cost totals per model used in the session.     |
| `/steer <message>`                                           | Inject a message into the active turn.                        |

`/steer` queues the message if a turn is running; otherwise it starts a new turn.

## Extensions and skills

| Command                         | Behavior                                                |
| ------------------------------- | ------------------------------------------------------- |
| `/skills`                       | List discovered skills.                                 |
| `/skill <name> [prompt]`        | Load a skill and optionally give it a prompt.           |
| `/extensions [doctor [--json]]` | List extension load status, or show diagnostics.        |
| `/reload`                       | Reload extensions, skills, and personas from disk.      |
| `/trust allow\|deny\|reset`     | Manage project trust for local extensions and personas. |
| `/mcp [reconnect [server]]`     | List MCP servers or reconnect one.                      |

## Appearance

| Command                            | Behavior                                    |
| ---------------------------------- | ------------------------------------------- |
| `/theme [auto\|dark\|light\|ansi]` | Open a live-preview picker, or set a theme. |

## Safety

| Command     | Behavior                                 |
| ----------- | ---------------------------------------- |
| `/approval` | Show the approval mode (legacy surface). |

## Arguments

Commands parse the text after the name as one argument string. Quotes are not required for multi-word values:

```text
/goal set Ship the login fix
```

Unknown names consume the input and print usage; they never fall through to the agent as a prompt. Skills are also invokable by bare name, so `review this diff` runs the `review` skill when one exists.

See [CLI](./cli.md) for keybindings and [Config](./config.md) for config fields.
