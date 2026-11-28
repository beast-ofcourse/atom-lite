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
- Media plays through a token-guarded `/media` read that supports byte ranges and has its own 256 MB cap. Office engines load from a token-guarded, same-origin `/engine` route that serves only allowlisted package assets. These responses carry `no-store` and `x-content-type-options: nosniff`, and symlinks that leave the workspace are rejected. Workspace HTML and SVG are still served as text.

## Use

The header model chip opens a searchable catalog refreshed from every configured provider. The composer switches effort (`low`/`medium`/`high`) and mode (`plan`/`yolo`), attaches files, and turns into a Stop control while a turn runs. Escape and `/stop` also cancel the turn.

Open a chat's row menu to **Pin** or **Unpin** it. Pinned chats stay in a `Pinned` group above the dated history and the choice is stored in browser storage.

The agent chip beside the model shows the active primary profile (`default`, `architect`, `reviewer`, `ultracode`, or a trusted project persona). Choosing a profile updates role instructions, temperature, and tool permissions. Switching is refused while a turn is running.

When the agent calls the `question` tool, the controlling tab shows a **Questions** form. Single-answer questions use option rows or a custom field; `multiple` questions use checkboxes. Submit returns every answer in order, while Dismiss, the close button, or Escape stops the turn without inventing an answer. A pending form follows control to another tab, and read-only viewers cannot answer.

`/mcp` opens the MCP servers overlay. Each server shows its state, tool count, exposed tools, and last error. **Refresh** re-reads the manager; **Connect** or **Disconnect** enables or closes that server for the running process without changing the config file. Connection changes are refused while a turn is running, and read-only viewer tabs cannot toggle servers.

Click the workspace path in the sidebar footer to open the host OS's native folder picker: Zenity or KDialog on Linux, Finder's chooser on macOS, and FolderBrowserDialog on Windows. On Android and Termux the same click opens the in-app directory explorer, because the native SAF folder picker is unreliable there. `ctrl/cmd+o` always opens the in-app directory explorer; `ctrl/cmd+k` opens the command palette. Typing `/` offers `/new`, `/help`, `/stop`, `/model`, `/theme`, `/cwd`, `/rename`, `/delete`, `/search`, `/export`, `/effort`, `/mode`, `/goal`, `/skills`, and `/mcp`.

Drag the left sidebar's right edge to resize it between 220 and 420 pixels, or focus the separator and use the arrow keys; double-click resets the width. The sidebar width is stored in browser storage.

## Workbench

The right-hand dock opens with the checklist button in the header or `ctrl/cmd+shift+r`. Drag its left edge to resize it, focus the separator and use the arrow keys, or double-click it to reset. On screens up to 1024px the dock covers the conversation with a scrim; tap the scrim or press Escape to close it. Open state, width, and tab layout are stored in browser storage per workspace and restored on reload. The dock animates open and closed, and focus returns to the control that opened it.

### Tabs

The dock keeps several tools open as tabs. Each tab shows a type icon and a title, and has a close button; middle-click a tab to close it. `+` opens a new-tab page with Review, Terminal, and Open file actions plus a bounded Recently closed list. Drag tabs to reorder them, or focus the strip and use the arrow keys. Switching tabs cross-fades briefly and keeps focus on the tab strip. Closing the active tab selects its neighbour; closing the last tab returns to the new-tab page.

| Shortcut           | Behavior                                                     |
| ------------------ | ------------------------------------------------------------ |
| `ctrl/cmd+shift+r` | Toggle the dock                                              |
| `ctrl/cmd+j`       | Open the Tasks tab                                           |
| `ctrl/cmd+alt+p`   | Open a file tab and focus its filter                         |
| `ctrl/cmd+alt+t`   | Open a terminal tab                                          |
| `ctrl/cmd+alt+r`   | Open the Review tab                                          |
| `ctrl/cmd+shift+t` | Reopen the last closed tab                                   |
| `ctrl/cmd+\`       | Toggle the workspace tree in the file tab                    |
| `ctrl/cmd+shift+f` | Fullscreen the active image or video preview                 |
| Middle-click       | Close a tab                                                  |
| `Escape`           | Leave fullscreen, then close the dock when no dialog is open |

Tabs whose files no longer exist are skipped on restore; the existence probe uses the read route for that file kind, and tabs stay with the workspace where they were opened.

### Files and previews

A file tab shows the workspace tree beside a preview, separated by a resizable divider whose width is remembered per workspace. Folders come before files in natural case-insensitive order. The filter matches path segments, and Enter opens the first match. Large folders show a truncation notice, and each row's tooltip gives its full relative path. Selecting a file that is already open focuses its tab instead of adding a duplicate.

The tree header button collapses the tree and hides the divider so the preview takes the space; a button in the preview header reopens it at the same width. The collapsed state is remembered per workspace, and the button exposes its expanded state to screen readers. Drag a file or folder row onto the composer to add a reference, or onto the workbench to preview it; a cloned row follows the pointer, the drag uses copy semantics, and clicking a row still opens or expands it. Dropping several files previews the first and opens the rest as tabs; dropping a folder reveals it in the tree, opening a collapsed tree first. A drop on a closed dock opens the dock.

Text and code previews highlight by language. A text or code preview is read-only until you choose **Edit**; **Save** uses a token-guarded write, rejects a stale revision, and is refused in plan mode and for read-only viewers. Images and SVG render as image elements through the token-guarded `/image` path, never as page markup: they open fitted, then support zoom, pan, and fullscreen. Video and audio play with native controls through the token-guarded `/media` path; metadata loads first and byte ranges let playback seek without downloading the whole file. Video also has a fullscreen control and responds to double-click. Markdown renders with HTML disabled and safe link targets, reusing the transcript's code highlighter and Mermaid renderer; `Source` shows the raw text and there is no edit control for Markdown. PDFs render page by page with page navigation, zoom, fit, rotate, download, and print controls; text annotations are stored in browser storage per file revision. DOCX, XLSX, and PPTX files render as paged pages, a sheet grid, and slides with navigation and zoom. Their pinned engines load on first use from the same-origin `/engine` route, run in one worker per format, and stop when the tab closes. Corrupt, encrypted, and legacy Office files fall back to the no-preview card.

Files with no renderer, and media above the 256 MB streaming cap, show a no-preview card with the file name, kind, and size plus `Download` and `Copy path` actions. Every preview follows the selected theme, and switching files cancels the previous load so a stale response cannot replace the new selection. Controls carry labels and visible focus rings; zoom, fullscreen, and tree controls are reachable by keyboard. Switching out of fullscreen with Escape leaves the dock open.

### Review

The Review tab lists workspace changes from a token-guarded read-only endpoint. Each entry shows a path and change summary, expands to added and removed lines, and opens the file preview. Long diffs are bounded with a truncation notice. Review does not post comments.

### Terminals

A terminal tab runs a real shell with the workspace as its working directory. Output renders ANSI colours and follows the tail until you scroll up; Ctrl+C interrupts the running command. Each tab owns one numbered shell. Terminal count and output buffers are capped. Closing a tab, disconnecting, or stopping the server ends its shell.

When the native PTY binary is unavailable, Atom-lite falls back to a pipe-backed shell. Commands and coloured output still work, but full-screen programs and terminal resizing are unavailable. This keeps `atom-lite --serve` working after installs where native install scripts are blocked.

Opening a terminal uses the same approval dialog and persona checks as the agent's shell tool. Plan mode and read-only viewers are refused. An interactive shell is not confined to the workspace by a path guard; that is a documented limit of terminal mode.

### Tasks and goals

The task ledger and goal render in the Tasks tab, with no change to their behaviour. The ledger lists pending, in-progress, completed, and cancelled tasks with their verification notes, updates live as the agent works, and restores the durable ledger when you resume a session. The same tab shows the goal statement, status, criteria, and constraints, and a context notice reports compaction starting or failing. Goal state is restored on resume. `/goal` works in the browser with the same forms as the terminal; like other mutators, it is refused for read-only viewers and while a turn runs.

### File references

Typing `@` in the composer opens a picker backed by the workspace tree. Type to filter, then use the arrow keys and Enter to choose. Selection inserts a `@path` chip and attaches the file through the existing attachment flow, so the agent can read it in the next turn. Remove the chip to drop the reference. A missing file shows an error instead of being skipped. Read-only viewers cannot use the picker.

Dragging a tree row into the composer uses the same contract. A file inserts a `@path` chip and attaches it; a folder inserts `@path/` without an attachment. Only paths from the loaded tree are accepted, and read-only viewers are refused. Dropping files from your operating system inserts one `@name` reference at the caret per file and attaches each through the native attachment flow; files over the 20 MB cap are referenced only. The picker and both drop paths share the same reference helper. A striped overlay labelled `Drop files to add` marks the target while dragging, and Escape clears the drag. The composer regains focus after the drop. A file over the 20 MB attachment cap is referenced but not attached, with a notice; a missing workspace file reports an error.

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
