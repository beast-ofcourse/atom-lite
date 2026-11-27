# Web UI

Start the browser surface with the same runtime, tools, sessions, and approvals as the terminal.

```bash
atom-lite --serve          # default port 7317, or the next free port
atom-lite --serve 8765
```

The command prints a localhost URL with a per-run token. Treat that URL as a secret while the server runs.

## Boundaries

- The server binds `127.0.0.1` only. There is no general `--host` flag.
- The page and every asset carry the run token. Requests with a foreign `Origin` or `Host` are rejected.
- The first tab controls the session. Later tabs are read-only viewers and take over if the controller leaves.
- The terminal and server take the same per-session lock, so they cannot drive one log at once.
- The workbench reads the workspace through token-guarded `/tree`, `/file`, and `/diff` endpoints. Writes go through an explicit, revision-checked `/file` request.

## Use

The header model chip opens a searchable catalog refreshed from every configured provider. The composer switches effort (`low`/`medium`/`high`) and mode (`plan`/`yolo`), attaches files, and turns into a Stop control while a turn runs. Escape and `/stop` also cancel the turn.

Open a chat's row menu to **Pin** or **Unpin** it. Pinned chats stay in a `Pinned` group above the dated history and the choice is stored in browser storage.

The agent chip beside the model shows the active primary profile (`default`, `architect`, `reviewer`, `ultracode`, or a trusted project persona). Choosing a profile updates role instructions, temperature, and tool permissions. Switching is refused while a turn is running.

When the agent calls the `question` tool, the controlling tab shows a **Questions** form. Single-answer questions use option rows or a custom field; `multiple` questions use checkboxes. Submit returns every answer in order, while Dismiss, the close button, or Escape stops the turn without inventing an answer. A pending form follows control to another tab, and read-only viewers cannot answer.

`/mcp` opens the MCP servers overlay. Each server shows its state, tool count, exposed tools, and last error. **Refresh** re-reads the manager; **Connect** or **Disconnect** enables or closes that server for the running process without changing the config file. Connection changes are refused while a turn is running, and read-only viewer tabs cannot toggle servers.

Click the workspace path in the sidebar footer to open the host OS's native folder picker: Zenity or KDialog on Linux, Finder's chooser on macOS, and FolderBrowserDialog on Windows. On Android and Termux the same click opens the in-app directory explorer, because the native SAF folder picker is unreliable there. `ctrl/cmd+o` always opens the in-app directory explorer; `ctrl/cmd+k` opens the command palette. Typing `/` offers `/new`, `/help`, `/stop`, `/model`, `/theme`, `/cwd`, `/rename`, `/delete`, `/search`, `/export`, `/effort`, `/mode`, `/goal`, `/skills`, and `/mcp`.

Drag the left sidebar's right edge to resize it between 220 and 420 pixels, or focus the separator and use the arrow keys; double-click resets the width. The sidebar width is stored in browser storage.

## Workbench

The right-hand dock opens with the checklist button in the header or `ctrl/cmd+shift+r`. Drag its left edge to resize it, focus the separator and use the arrow keys, or double-click it to reset. On screens up to 1024px the dock covers the conversation with a scrim; tap the scrim or press Escape to close it. Open state, width, and tab layout are stored in browser storage per workspace and restored on reload.

### Tabs

The dock keeps several tools open as tabs. Each tab shows a type icon and a title, and has a close button. `+` opens a new-tab page with Review, Terminal, and Open file actions plus a bounded Recently closed list. Drag tabs to reorder them, or focus the strip and use the arrow keys. Closing the active tab selects its neighbour; closing the last tab returns to the new-tab page.

| Shortcut           | Behavior                                         |
| ------------------ | ------------------------------------------------ |
| `ctrl/cmd+shift+r` | Toggle the dock                                  |
| `ctrl/cmd+j`       | Open the Tasks tab                               |
| `ctrl/cmd+alt+p`   | Open a file tab and focus its filter             |
| `ctrl/cmd+alt+t`   | Open a terminal tab                              |
| `ctrl/cmd+alt+r`   | Open the Review tab                              |
| `ctrl/cmd+shift+t` | Reopen the last closed tab                       |
| `Escape`           | Close the dock when no dialog or overlay is open |

Tabs whose files no longer exist are skipped on restore, and tabs stay with the workspace where they were opened.

### Files and previews

A file tab shows the workspace tree beside a preview, separated by a resizable divider whose width is remembered per workspace. Folders come before files in natural case-insensitive order. The filter matches path segments, and Enter opens the first match. Large folders show a truncation notice, and each row's tooltip gives its full relative path. Selecting a file that is already open focuses its tab instead of adding a duplicate.

Text and code previews highlight by language. A preview is read-only until you choose **Edit**; **Save** uses a token-guarded write, rejects a stale revision, and is refused in plan mode and for read-only viewers. Images are served only from inside the workspace. PDFs render page by page with page navigation, zoom, fit, rotate, download, and print controls; text annotations are stored in browser storage per file revision. Binary and unsupported files show a no-preview state with their size. The preview follows the selected theme.

### Review

The Review tab lists workspace changes from a token-guarded read-only endpoint. Each entry shows a path and change summary, expands to added and removed lines, and opens the file preview. Long diffs are bounded with a truncation notice. Review does not post comments.

### Terminals

A terminal tab runs a real shell with the workspace as its working directory. Output renders ANSI colours and follows the tail until you scroll up; Ctrl+C interrupts the running command. Each tab owns one numbered shell and sends resize messages so full-screen programs draw correctly. Terminal count and output buffers are capped. Closing a tab, disconnecting, or stopping the server ends its shell.

Opening a terminal uses the same approval dialog and persona checks as the agent's shell tool. Plan mode and read-only viewers are refused. An interactive shell is not confined to the workspace by a path guard; that is a documented limit of terminal mode.

### Tasks and goals

The task ledger and goal render in the Tasks tab, with no change to their behaviour. The ledger lists pending, in-progress, completed, and cancelled tasks with their verification notes, updates live as the agent works, and restores the durable ledger when you resume a session. The same tab shows the goal statement, status, criteria, and constraints, and a context notice reports compaction starting or failing. Goal state is restored on resume. `/goal` works in the browser with the same forms as the terminal; like other mutators, it is refused for read-only viewers and while a turn runs.

### File references

Typing `@` in the composer opens a picker backed by the workspace tree. Type to filter, then use the arrow keys and Enter to choose. Selection inserts a `@path` chip and attaches the file through the existing attachment flow, so the agent can read it in the next turn. Remove the chip to drop the reference. A missing file shows an error instead of being skipped. Read-only viewers cannot use the picker.

Assistant text renders as markdown with syntax-highlighted code, local images, and Mermaid diagrams. Tool edits show a unified inline diff. Long sessions load earlier messages on demand.

Files attached from the composer are written under `<workspace>/.atom-lite/attachments/<session>/` so the agent's tools can read them. Nothing is uploaded.

## Reconnects and approvals

A dropped socket reconnects and replays the in-flight turn once. A pending approval returns to the reconnecting tab; it fails safe as a denial if nobody returns within the grace period.

A message typed during a turn joins the steering queue and is delivered before the turn ends.

## Themes

The configured `ui.theme` seeds the browser theme. `light`, `solarized`, and `ansi` give the light theme; other themes are dark. The sidebar footer can switch between System, Light, and Dark and remembers the choice in browser storage without changing config.

## Phone access

Run:

```bash
atom-lite --serve --share
```

Share mode binds the web server on the LAN and prints a URL plus QR code using the machine's private IPv4 address. Scan the code with a phone on the same network. The URL contains the run token.

Use `--no-qr` when the terminal cannot draw the code. Ctrl-C stops the server. Default `--serve` stays on `127.0.0.1`.

Share mode uses plain HTTP on the local network and relies on the token for access. Do not use it on an untrusted network.

## Parity boundary

The browser is an observe + steer surface for session state, not a pixel-parity TUI. State that already has an event and a controller guard is ported as it appears: goal, task ledger, compaction status, approvals, questions, and the context meter.

Browser terminal tabs render ANSI output and run interactive programs. Shell mode, extension widgets, tool-specific TUI chrome, and the visualizer remain terminal-only or deferred. The terminal remains the primary surface. See [CLI](./cli.md).

The visual system lives in [`web/DESIGN.md`](../web/DESIGN.md).
