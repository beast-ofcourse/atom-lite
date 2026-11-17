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

`ctrl/cmd+o` opens the working-directory explorer; `ctrl/cmd+k` opens the command palette. Typing `/` offers `/new`, `/help`, `/stop`, `/model`, `/theme`, `/cwd`, `/rename`, `/delete`, `/search`, `/export`, `/effort`, `/mode`, `/skills`, and `/mcp`.

Drag the left sidebar's right edge to resize it between 220 and 420 pixels, or focus the separator and use the arrow keys; double-click resets the width. The sidebar width is stored in browser storage.

The session task ledger opens in a right-hand panel. Toggle it with the checklist button or `ctrl/cmd+j`. Drag the panel's left edge to resize it between 240 and 480 pixels, or focus the separator and use the arrow keys; double-click resets the width. The panel lists pending, in-progress, completed, and cancelled tasks with their verification notes, updates live as the agent works, and restores the durable ledger when you resume a session. Open state and width are stored in browser storage.

Assistant text renders as markdown with syntax-highlighted code, local images, and Mermaid diagrams. Tool edits show a unified inline diff. Long sessions load earlier messages on demand.

Files attached from the composer are written under `<workspace>/.atom-lite/attachments/<session>/` so the agent's tools can read them. Nothing is uploaded.

## Reconnects and approvals

A dropped socket reconnects and replays the in-flight turn once. A pending approval returns to the reconnecting tab; it fails safe as a denial if nobody returns within the grace period.

A message typed during a turn joins the steering queue and is delivered before the turn ends.

## Themes

The configured `ui.theme` seeds the browser theme. `light`, `solarized`, and `ansi` give the light theme; other themes are dark. The sidebar footer can switch between System, Light, and Dark and remembers the choice in browser storage without changing config.

## Phone access

Install `cloudflared`, then run:

```bash
atom-lite --serve --share
```

The server stays on `127.0.0.1`; an outbound HTTPS tunnel publishes it. The command prints a local diagnostics URL and a shared URL with a QR code. The shared URL contains the run token. Use `--tunnel-command 'COMMAND {port}'` for another provider and `--no-qr` when the terminal cannot draw the code. The tunnel and server close together on Ctrl-C.

## Not in the browser yet

ANSI rendering, shell mode, and extension widgets. The terminal remains the primary surface. See [CLI](./cli.md).

The visual system lives in [`web/DESIGN.md`](../web/DESIGN.md).
