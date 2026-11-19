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

## Use

The header model chip opens a searchable catalog refreshed from every configured provider. The composer switches effort (`low`/`medium`/`high`) and mode (`plan`/`yolo`), attaches files, and turns into a Stop control while a turn runs. Escape and `/stop` also cancel the turn.

Open a chat's row menu to **Pin** or **Unpin** it. Pinned chats stay in a `Pinned` group above the dated history and the choice is stored in browser storage.

The agent chip beside the model shows the active primary profile (`default`, `architect`, `reviewer`, `ultracode`, or a trusted project persona). Choosing a profile updates role instructions, temperature, and tool permissions. Switching is refused while a turn is running.

When the agent calls the `question` tool, the controlling tab shows a **Questions** form. Single-answer questions use option rows or a custom field; `multiple` questions use checkboxes. Submit returns every answer in order, while Dismiss, the close button, or Escape stops the turn without inventing an answer. A pending form follows control to another tab, and read-only viewers cannot answer.

`/mcp` opens the MCP servers overlay. Each server shows its state, tool count, exposed tools, and last error. **Refresh** re-reads the manager; **Connect** or **Disconnect** enables or closes that server for the running process without changing the config file. Connection changes are refused while a turn is running, and read-only viewer tabs cannot toggle servers.

Click the workspace path in the sidebar footer to open the host OS's native folder picker: Zenity or KDialog on Linux, Finder's chooser on macOS, FolderBrowserDialog on Windows, and the Android SAF folder picker in Termux. `ctrl/cmd+o` opens the in-app directory explorer instead; `ctrl/cmd+k` opens the command palette. Typing `/` offers `/new`, `/help`, `/stop`, `/model`, `/theme`, `/cwd`, `/rename`, `/delete`, `/search`, `/export`, `/effort`, `/mode`, `/goal`, `/skills`, and `/mcp`.

Drag the left sidebar's right edge to resize it between 220 and 420 pixels, or focus the separator and use the arrow keys; double-click resets the width. The sidebar width is stored in browser storage.

The session task ledger opens in a right-hand panel. Toggle it with the checklist button or `ctrl/cmd+j`. Drag the panel's left edge to resize it between 240 and 480 pixels, or focus the separator and use the arrow keys; double-click resets the width. The panel lists pending, in-progress, completed, and cancelled tasks with their verification notes, updates live as the agent works, and restores the durable ledger when you resume a session. Open state and width are stored in browser storage.

The same panel shows the goal statement, status, criteria, and constraints, and a context notice reports compaction starting or failing. Goal state is restored on resume. `/goal` works in the browser with the same forms as the terminal; like other mutators, it is refused for read-only viewers and while a turn runs.

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

ANSI rendering, shell mode, extension widgets, tool-specific TUI chrome, and the visualizer are terminal-only or deferred. The terminal remains the primary surface. See [CLI](./cli.md).

The visual system lives in [`web/DESIGN.md`](../web/DESIGN.md).
