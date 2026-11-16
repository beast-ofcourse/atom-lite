# Web surface design system

Surface mode: **Operate**. The browser client is a task surface for the same
local agent as the terminal. This system is a deliberate replacement of the
earlier compact terminal-translation world: the browser surface now follows the
ChatGPT web interface — an achromatic, conversation-first workspace where the
transcript is the product and the chrome recedes.

The product truth is still Atom-lite: local-first runtime, tool cards,
approvals, workspace sessions, and terminal-configured light/dark. ChatGPT is
the visual and interaction reference, not a content template. No ChatGPT
branding, account surfaces, model picker, attachments, voice, or commercial
claims are copied.

## Research record

Decisions below came from the live `chatgpt.com` document and stylesheet tokens
(extracted 2026-11-16), plus measured community references:

- `chatgpt.com` live DOM and CSS custom properties: `--bg-surface-main`,
  `--bg-surface-sidebar`, `--message-user-surface`, `--composer-border`,
  `--composer-shadow`, `--sidebar-rail-width`, `--header-height`,
  `--label-primary`, `--label-secondary`, `--glass-*`.
- Refero Styles, "ChatGPT design system" (2026-02-14): `#f9f9f9` sidebar,
  `#ffffff` canvas, `#0d0d0d` ink, `#5d5d5d` secondary, `#8f8f8f` tertiary,
  `rgba(0,0,0,.1)` hairline, 10px control radius, 16px body.
- AI Web Style, "ChatGPT" (updated 2026-11-11): `#212121` dark canvas,
  `#181818` dark sidebar, `#2f2f2f` user bubble, `#ececec` dark text,
  `#b4b4b4` dark secondary, 32pt circular send, 18pt user bubble.
- Reverse-engineered ChatGPT sidebar structure: 260px expanded width, 52px
  rail/header height, 40px menu rows, 10px menu radius, 12px section headers,
  dated history groups (`Today`, `Yesterday`, `Previous 7 days`,
  `Previous 30 days`, then month-year), 6px item gutters.

Measured values from these sources shape the tokens below. Where the
Atom-lite protocol or accessibility forces a change, the fidelity contract
records the adaptation and its reason.

## Fidelity contract

Adopted from ChatGPT:

- 260px left sidebar, 52px header, hairline separators, no main-area border.
- Monochrome palette. Blue appears only on links and focus rings.
- User prompts as right-aligned soft-gray bubbles; assistant replies as
  unframed prose with a small mark, never a bubble.
- 16px/1.75 prose, 14px UI, 12px metadata, 400/500/600 weights.
- Centered 768px conversation column and a 28px-radius composer with a
  circular send button.
- Centered "What can I help with?" empty state on a new conversation.
- Dated, filterable chat history rows with 40px height and 10px radius.
- Flat surfaces; elevation only on floating UI (approval dialog, mobile
  sidebar) via a single shadow or border, never both.

Adapted for Atom-lite truth:

- The model chip opens a real overlay whose live catalog comes from every
  configured provider; the browser never asks for API keys.
- The composer carries the native plus button, effort and plan/yolo chips, and
  the send button. No voice control is shown because the protocol has none.
- Assistant responses keep a working copy action only; thumbs and regenerate
  would be dead controls.
- Tool cards, thinking disclosure, queued steering messages, and the approval
  dialog are first-class in the ChatGPT vocabulary rather than removed.
- Theme starts from the terminal configuration, then offers a three-state
  `System / Light / Dark` switch in the sidebar with the choice persisted
  locally; the terminal value is only the first default, not a lock.
- Söhne is proprietary and is not vendored. The stack names it first, then
  falls back through the same Helvetica/Segoe/system grotesques ChatGPT uses
  on platforms without the face. Local-first means no hosted font request.

## Tokens

All values live in `styles.css` as custom properties on `:root` (dark) with a
`:root[data-theme="light"]` override. Components use tokens only.

### Colour

| Token             | Dark                        | Light                        | Use                            |
| ----------------- | --------------------------- | ---------------------------- | ------------------------------ |
| `--bg`            | `#212121`                   | `#ffffff`                    | conversation canvas            |
| `--sidebar-bg`    | `#171717`                   | `#f9f9f9`                    | navigation ground              |
| `--surface`       | `#2f2f2f`                   | `#f4f4f4`                    | chips, tool cards, inline code |
| `--user-bubble`   | `#303030`                   | `#f4f4f4`                    | user prompt bubble             |
| `--composer-bg`   | `#303030`                   | `#ffffff`                    | composer ground                |
| `--hover`         | `#2a2a2a`                   | `#ececec`                    | sidebar and control hover      |
| `--active`        | `#2f2f2f`                   | `#e8e8e8`                    | selected history row           |
| `--border`        | `rgba(255,255,255,.12)`     | `rgba(13,13,13,.1)`          | hairlines and card edges       |
| `--border-strong` | `rgba(255,255,255,.24)`     | `rgba(13,13,13,.2)`          | control boundaries, scrollbar  |
| `--text`          | `#ececec`                   | `#0d0d0d`                    | body, headings, icons          |
| `--text-dim`      | `#b4b4b4`                   | `#5d5d5d`                    | secondary copy, metadata       |
| `--text-faint`    | `#8f8f8f`                   | `#676767`                    | group labels, placeholders     |
| `--link`          | `#7ab7ff`                   | `#0267ff`                    | inline links                   |
| `--focus`         | `#a8c7fa`                   | `#0b57d0`                    | keyboard focus ring            |
| `--send-bg`       | `#ffffff`                   | `#0d0d0d`                    | circular send button           |
| `--send-fg`       | `#0d0d0d`                   | `#ffffff`                    | send glyph                     |
| `--send-disabled` | `#4d4d4d`                   | `#cccccc`                    | send at rest when empty        |
| `--danger`        | `#ff6961`                   | `#c0392b`                    | failures, destructive states   |
| `--warn`          | `#e2b25a`                   | `#8a5a00`                    | running, queued, read-only     |
| `--ok`            | `#58cd78`                   | `#198038`                    | success and controlling state  |
| `--code-bg`       | `#0d0d0d`                   | `#f7f7f7`                    | fenced code ground             |
| `--code-head`     | `#171717`                   | `#efefef`                    | code block header              |
| `--inline-bg`     | `rgba(255,255,255,.08)`     | `rgba(13,13,13,.06)`         | inline code                    |
| `--diff-add-bg`   | `rgba(88,205,120,.10)`      | `rgba(25,128,56,.08)`        | added diff line                |
| `--diff-add-fg`   | `#b7e4c4`                   | `#17603a`                    | added diff text                |
| `--diff-del-bg`   | `rgba(255,105,97,.10)`      | `rgba(192,57,43,.07)`        | removed diff line              |
| `--diff-del-fg`   | `#f0b8b4`                   | `#8f2b22`                    | removed diff text              |
| `--overlay`       | `rgba(0,0,0,.5)`            | `rgba(0,0,0,.4)`             | modal and drawer scrim         |
| `--shadow`        | `0 8px 32px rgba(0,0,0,.4)` | `0 8px 32px rgba(0,0,0,.14)` | floating elevation only        |
| `--selection`     | `rgba(168,199,250,.3)`      | `rgba(2,103,255,.18)`        | text selection                 |
| `--scrollbar`     | `rgba(180,180,180,.35)`     | `rgba(13,13,13,.22)`         | overlay-style scrollbar thumb  |

Contrast commitments (WCAG 2.1, measured during the finish audit):

| Pair                       | Dark | Light |
| -------------------------- | ---- | ----- |
| `--text` on `--bg`         | 13.6 | 19.4  |
| `--text-dim` on `--bg`     | 7.8  | 6.6   |
| `--text-faint` on `--bg`   | 5.0  | 5.6   |
| `--link` on `--bg`         | 7.7  | 4.8   |
| `--send-fg` on `--send-bg` | 19.4 | 19.4  |
| placeholder on composer    | 5.0  | 5.6   |

Body, secondary, placeholder, and control copy clear 4.5:1. Focus rings are a
2px `--focus` ring offset 2px from the control. Disabled send uses
`--send-disabled` with a visible arrow, not a vanishing control.

### Syntax

`--syntax-comment`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`,
`--syntax-title`, `--syntax-attr`, `--syntax-builtin`, `--syntax-literal`, and
`--syntax-type` are defined per theme. highlight.js emits class names; the
stylesheet owns colour, so there is no vendored highlight theme.

### Type

| Token            | Size | Use                                     |
| ---------------- | ---- | --------------------------------------- |
| `--text-xs`      | 12px | group labels, metadata, disclaimer      |
| `--text-sm`      | 13px | sidebar meta, tool summary, code header |
| `--text-ui`      | 14px | sidebar rows, buttons, tool names       |
| `--text-base`    | 16px | prose, user bubble, composer            |
| `--text-lg`      | 20px | small empty-state heading               |
| `--text-display` | 28px | home heading (24px under 768px)         |

Weights are 400 for prose, 500 for navigation and emphasis, 600 for headings
and state labels. Body line-height is 1.75 (ChatGPT prose rhythm); UI is 1.4.
Prose measure is capped by the 768px thread column; user bubbles cap at 70% of
the column.

### Space, radius, motion

`--space-1..8` = 4, 8, 12, 16, 20, 24, 32, 40 px. Radii: `--radius-sm` 6px,
`--radius-md` 10px, `--radius-lg` 12px, `--radius-xl` 16px, `--radius-pill`
999px, `--radius-composer` 28px. Sidebar rows are 40px high with 6px inline
gutters. Composer grows to 200px. Motion: one authored sidebar slide/crossfade
at 200ms `cubic-bezier(.2,0,0,1)`; 120ms hover transitions elsewhere. Streamed
text never animates in. Under `prefers-reduced-motion: reduce`, all
transitions collapse.

## Layout

```
┌────────────── 260px ──────────────┬──────────────── main ────────────────┐
│ brand            [collapse]       │ header 52px: [toggle] model · role  │
│ New chat                          │                                      │
│ Search chats                      │        transcript 768px max          │
│ Today                             │        (user bubbles right)          │
│   session rows (40px)             │                                      │
│ Yesterday                         │                                      │
│   …                               │   composer 768px, 28px radius        │
│ workspace footer                  │   suggestion chips / disclaimer      │
└───────────────────────────────────┴──────────────────────────────────────┘
```

- The page is a full-viewport grid, `100dvh`, with the sidebar as its own
  column. Only the transcript scrolls; header and composer never cover content.
- On a new conversation the composer sits in the optical center with the
  greeting above it. After the first message it docks to the bottom of the main
  column without moving the transcript.
- At `≤768px` the sidebar becomes an overlay drawer over a scrim; the main
  header gains a menu button and the composer loses its side margin. Code
  blocks, tables, and tool output scroll inside themselves; the page body never
  scrolls horizontally.

## Components

### Sidebar

- Ground `--sidebar-bg`, right hairline. Brand mark is an authored atom-orbit
  SVG plus the `atom-lite` wordmark; a panel toggle sits opposite.
- `New chat` and `Search chats` are menu rows. Search is a real filter over
  the session list, not a decorative field.
- History is grouped by recency, sorted newest first, one line per row with
  ellipsis, tooltip with message count and timestamp. The active row uses
  `--active`; hover uses `--hover`. Each row reveals a three-dot button on
  hover/focus (always on touch) that opens a small menu with **Rename** and
  **Delete**.
- Footer is a workspace/account block: avatar disc, a one-line working-directory
  hint that opens the explorer, provider · model, and a theme toggle. Clicking
  the path or `Ctrl/Cmd+O` opens the directory explorer.
- Collapse: the sidebar width animates to 0 and the main header reveals the
  panel toggle. The state persists in `localStorage`. Mobile uses a scrim and
  closes on scrim click or Escape.

### Header

52px, transparent over the canvas, no divider. Left: panel toggle (only when
the sidebar is collapsed or on mobile) and the model chip — a real button with
a small atom glyph, `provider · model`, and a chevron that opens the model
picker. Right: role chip with a status dot (`controlling` green, `read-only
viewer` amber). The role chip is the only place control state is written.

### Transcript and messages

- Single 768px column. Assistant blocks: 24px mark, prose, optional copy
  action. No avatar for user messages; no role labels.
- User bubble: `--user-bubble`, 18px radius with a 4px bottom-right corner,
  padding 10px 16px, max-width 70%, wraps anywhere.
- Assistant prose: 16px/1.75, headings at 1.5 / 1.25 / 1.125 / 1em, 600 weight,
  generous block spacing. No bubble, border, or card.
- Copy is a 28px icon button under the response, revealed on hover and focus,
  always visible on touch. It copies the raw model text and confirms with a
  check for 1.2s.
- The transcript has `aria-live="polite"`; streaming content is announced but
  never visually animated.

### Markdown and code

markdown-it with `html: false`; links open in a new tab with
`rel="noreferrer noopener"` and use the blue link colour with a 2px underline
offset. Tables scroll inside themselves with hairline borders.

Fenced code is a `.code-block`: 16px radius, 1px hairline, header bar
(`--code-head`) with the language label and a functional `Copy` button, then a
`pre` on `--code-bg` at 14px mono with horizontal scroll. Unknown languages
render as escaped plain text. The copy button copies the rendered code text.

Images render as lazy, async-decoded blocks with a hairline and 12px radius;
relative paths are rewritten through the token-guarded `/image` endpoint, which
serves only workspace images and rejects escapes. Clicking an image opens a
lightbox. A failed image collapses to an accessible "Image unavailable" row.

A `mermaid` fence becomes a `.mermaid-block`: the source stays visible while the
diagram loads, then Mermaid 11 renders a themed SVG above it. The official
bundle is loaded lazily on first use, uses `securityLevel: "strict"`, and is
re-rendered on theme changes. If parsing or loading fails, the original source
and Copy button remain usable with a quiet "preview unavailable" note.

### Thinking

A borderless disclosure inside the assistant flow: 14px secondary text with a
drawn chevron that rotates on open. Expanded content is 14px/1.65 secondary
copy on the canvas, indented by a quiet hairline rule. It is subordinate to the
answer and never looks like a response bubble. Live thinking stays open and
adds a small amber dot to `Thinking`; the activity row owns all motion while it
runs. On completion the label becomes `Thought for Ns` and the disclosure
collapses. Restored thoughts come from the durable `message.thinking` field in
session history and use the quieter `Thought` label; no client-side cache is
involved. Expanding an already-visible block uses a 180ms opacity/translation
settle, with reduced motion keeping only the state change.

### Tool cards

A 12px-radius card on `--surface` with a hairline border. Header is a button:
drawn tool glyph, tool name at 14px/500 (not accent-coloured), one-line
monospace argument summary at 12px, and a state marker (`Running`, `Done`,
`Failed`) with colour plus text. The body contains a scrollable output tail
(60k chars / 400 lines cap with an "earlier lines" marker) on `--code-bg`.

A `write`/`edit` diff replaces the old plain-text extra with an inline unified
diff: a code-head-style bar carries `diff`, the path, `+N −M`, and Copy; the body
uses one row per line with a sign column, hunk separators, quiet context, and
subtle add/remove background tints from `--diff-*`. Adjacent remove/add runs are
paired so changed words carry a slightly stronger tint. Signs and labels carry
the meaning without colour. The full diff stays in the card's data for Copy;
rendering is capped at 400 lines/60k chars with an explicit more-lines marker.
Headers toggle the body and expose `aria-expanded`.

### Approval

Centered dialog, max 560px, 16px radius, elevated `--bg` with `--shadow` and no
decorative border. Title 18px/600, tool chip, command block on `--code-bg`,
cwd metadata. Actions: filled primary `Approve` (inverted ink), secondary
`Deny`, quiet `Trust for session`. Focus enters the dialog, Tab is trapped,
Escape denies, and focus returns to the composer. Only the controlling tab can
answer.

### Composer

Centered 768px shell, 28px radius, `--composer-bg`, 1px `--border` and the
light composer shadow (dark: inset hairline only). Textarea is 16px with 16px
padding; Enter sends, Shift+Enter breaks; it grows to 200px. The bottom row
carries the native file-picker plus button, effort and plan/yolo chips on the
left, and a 36px circular send button on the right, filled `--send-bg` with an
up-arrow in `--send-fg`.
Disabled send uses `--send-disabled` and keeps its shape. Queued steering
messages appear above the composer as small `Queued` rows. The disclaimer below
is 12px `--text-faint`: "Atom-lite can make mistakes. Check important info."

### Activity and stopping

A 12px status row sits between the queued rows and the composer and mirrors the
terminal activity line. Idle is a green dot and `Ready`. A running turn shows a
looped ring plus a rotating verb — `formulating`, `thinking`, or `working`
(`working`, `cooking`, `crafting`, `building`, `brewing`, `crumbling`) — the
elapsed time, and the current tool name when one is active. Waiting for an
approval swaps to an amber pulse and `Waiting for approval`; a disconnect is a
red `Disconnected`. The controlling tab can cancel with Escape, the inline Stop
button, or `/stop`; the server broadcasts `turn_stopping`, denies any pending
approval so the runtime can unwind, and ends the turn with `stopped: true`.
The row settles on `Stopped` for four seconds, then returns to `Ready`; the
cancellation is never shown as an error toast. Reduced-motion users get the
static phase marker instead of the spin and pulse.

### Home state

On a new conversation: the model header stays, the transcript is empty, and a
centered stack holds `What can I help with?` at 28px/400, the composer, and four
suggestion chips (`Explain this codebase`, `Find a bug`, `Write tests`,
`Review my changes`). Chips are real controls: clicking fills the composer and
focuses it. The stack is vertically centered between the header and the bottom
of the viewport; it never overlaps the disclaimer.

### Model overlay

Clicking the header chip or running `/model` opens a centered 620px overlay
with a search field, a **Refresh** action, and a provider-grouped list. The
overlay opens immediately with the last known catalog, then requests
`refresh_models`; the server asks every configured provider for its live model
list (`listModelsForProvider`) and broadcasts the merged result. No model list
is hardcoded in the browser and no API key is requested. The active pair carries
a check; selecting a row switches the live runtime and closes the overlay.
Arrow keys move, Enter switches, Escape closes. A failed switch or refresh
reports the server error in a toast and restores the control.

### Workspace explorer

`Ctrl/Cmd+O`, `/cwd`, or the footer path opens a centered 620px dialog. It shows
an editable absolute path, a parent-folder button, a Go action, and a scrollable
directory list. Selecting a folder drills into it; **Use this folder** switches
the server workspace, runtime tools, and approvals together, then opens a new
chat in that workspace. Only directories are accepted, `~` expands to the home
directory, and relative paths resolve against the current workspace. Session
history never crosses workspace boundaries. `/cwd <path>` switches directly
without opening the dialog.

### Session actions and dialogs

The row menu offers **Rename** and **Delete**. Rename opens a 480px dialog with
one labelled title field; Delete names the chat and requires confirmation.
Both use the same 16px-radius elevated surface as Approval, with Cancel and a
primary or destructive action. Deleting the active chat has the server create a
fresh chat first, so no tab is left pointing at a removed log. These actions
also exist as `/rename <title>` and `/delete`.

### Attachments

The plus button in the composer opens the platform's native file chooser via a
visually hidden `<input type="file" multiple>` with no `accept` filter, so
Windows, Linux, macOS, Android, and iOS all offer their normal picker and every
file type is selectable. Selected files appear as removable chips with name and
size. The browser base64-encodes each file and sends `attach_file`; the server
validates the basename, caps each file at 20 MB and each message at 10 files,
and writes it under `<workspace>/.atom-lite/attachments/<session>/`. The next
turn receives a compact `[Attached local files]` list of paths so the agent's
`read`/`bash` tools can inspect them. The marker is stripped from the visible
user bubble. Removing a chip deletes the stored file.

### Skills and MCP overlays

`/skills` requests `list_skills` and opens a centered overlay listing every
skill from the runtime registry with its description and `project`/`global`
scope. `/mcp` requests `list_mcp` and lists each server with a state dot, state
label, tool count, tool names, and the last error when failed. Both are
read-only overlays; they are available to viewer tabs and always reflect the
live manager rather than a cached browser list.

### Slash commands and command palette

Typing `/` in the composer opens an anchored autocomplete list built from one
client registry: `/new`, `/help`, `/stop`, `/model`, `/theme`, `/cwd`,
`/rename`, `/delete`, `/search`, `/export`, `/effort`, `/mode`, `/skills`,
`/mcp`. Arrow keys move, Tab completes, Enter runs,
Escape closes. `Ctrl/Cmd+K` opens the same registry in a centered command
palette with a search field and keyboard navigation. Mutating commands are
hidden from a read-only viewer. Unknown slash commands never reach the agent;
they produce a toast pointing to `/help`. `/search` filters the sidebar,
`/theme` accepts `system|light|dark`, `/stop` cancels the running turn, and
`/export` downloads a Markdown transcript generated in the browser.

### Browser surfaces

Selection, caret, scrollbars, focus rings, link underlines, and native form
controls are themed from the palette. Scrollbars are overlay-style: an 8px
transparent gutter with a 4px `--scrollbar` thumb that darkens on hover, and
`scrollbar-width: thin` in Firefox. Focus rings are 2px `--focus` with a 2px
offset; disabled controls dim but retain their shape.

## Theme mapping

The server maps the configured terminal theme:

- `light`, `solarized`, `ansi`, or `--no-color` / `NO_COLOR` → **light**
- every other theme (`dark`, `dracula`, `monokai`, `nord`, `auto` resolved
  dark) → **dark**

The resolved value is injected as `<html data-theme="…">` when served as the
first default, and an inline head script applies any locally stored override
before the stylesheet paints. A three-state control in the sidebar footer
cycles System / Light / Dark; `System` follows `prefers-color-scheme` live, and
explicit choices are persisted in `localStorage` under `atom-lite.web.theme`.
`color-scheme` follows the resolved theme so native controls match.

## Session history

The durable JSONL log stores messages and tool results. Transient detail —
thinking deltas and live tool output — lives in the in-flight replay buffer
only. A reconnect during a turn restores the turn exactly, including its
thinking and tool tails; a turn that finished while the page was away comes
back as its messages and tool results. The sidebar's groups and search are
derived from the same workspace session listing, so the browser never invents
history. A rename appends a `session_renamed` event to the durable log; a delete
removes the log through the store's lock-guarded delete, and deleting the active
chat opens a replacement before the old log is removed.

## Vendored assets

- `vendor/markdown-it.min.js` — markdown-it 15.0.3, MIT
  (`vendor/LICENSE.markdown-it.txt`)
- `vendor/highlight.min.js` — highlight.js 11.12.0 (cdn-assets build), BSD-3
  (`vendor/LICENSE.highlight.js.txt`)
- `vendor/mermaid.min.js` — Mermaid 11.12.0, MIT
  (`vendor/LICENSE.mermaid.txt`), loaded lazily only when a mermaid fence exists

All three are served by the local server with the same per-run token as every
other asset. There is no build step. Model text is never trusted as HTML. Icons are
authored inline SVG (24×24 viewBox, 1.75 stroke) in the page's sprite.

## Decisions

- One visual world: ChatGPT's achromatic conversation shell. No gradients,
  glass, glow, or coloured card rules.
- Blue is a link/focus colour, never a primary button fill. The primary send
  and dialog actions are inverted ink.
- Assistant prose is unframed; containers appear only for user prompts, tools,
  code, and floating UI.
- Tool output stays monospace and unwrapped from markdown: logs are data.
- Status is text plus colour, never colour alone.
- The transcript is one column at every width; no sidebars inside the main
  column and no card grids.
- Client-owned preferences (theme, sidebar state) live in `localStorage`;
  server-owned state (model, workspace, sessions, approvals) is remote and
  broadcast to every tab.
- Scrolling and streaming rendering are coalesced into one animation frame;
  the sidebar is rebuilt only on session data changes, never on control
  changes or every keystroke.
- Assistant and thinking deltas are presented from a bounded queue. Arrival is
  never delayed or dropped, but the visible tail advances at a readable pace;
  a finalizing turn drains faster so `turn_end` still settles promptly. While
  text streams, the body is plain text with a quiet caret and gets one full
  markdown render at the end, avoiding a reparse of the whole answer per frame.
- History is windowed to the latest 80 events with an explicit `Load earlier
messages` boundary. Loading more preserves scroll position. Markdown HTML and
  tool-card lookups are cached, Mermaid diagrams render only near the viewport,
  and live blocks opt out of `content-visibility` containment.
- Motion explains state: the stream caret, the live thinking dot, the
  activity spinner, and the user-triggered disclosure settle are the whole
  vocabulary. No section reveals, stagger, bounce, or parallax.
- New surfaces add a token before adding a one-off value.

## Audit record

Audited 2026-11-16 in Chromium and Brave (Playwright) against the real server
and the fake provider, dark and light, 1440×900 and 390×844.

- **Rendered:** sidebar, home state, conversation with markdown/code/table/tool
  card, local image, Mermaid SVG, thinking block, approval dialog, read-only
  viewer, collapsed sidebar, mobile drawer, live model overlay, slash
  autocomplete, command palette, attachment chips, skills overlay, MCP overlay,
  session row menu, rename/delete dialogs, theme menu, and workspace explorer,
  in dark and light at 1440×900 and 390×844.
- **Contrast:** token pairs measured; body, secondary, link, and placeholder
  copy meet 4.5:1. Focus rings meet 3:1 against the canvas. Hairline card and
  control boundaries stay deliberately quiet, matching ChatGPT; controls are
  also identified by surface and text.
- **Responsive:** no horizontal overflow at 1440, 390, or 320; the drawer and
  scrim behave; long session titles and workspace paths ellipsize; the desktop
  composer measures 768px and the mobile composer fills the 390px column with
  its 28px radius intact; inline diffs scroll inside their own body rather than
  widening the page; safe-area padding keeps the composer and header usable on
  notched devices, and coarse pointers get larger primary controls.
- **Interaction:** new chat, session resume, search filter, rename, delete of
  an active session (fresh chat opened), live model refresh from four provider
  models, model switch, local attachment upload and removal, skills and MCP
  overlays, workspace explorer navigation and switch, theme overrides, sidebar
  collapse, approval approve, the read-only viewer state, and stopping a live
  turn with Escape and `/stop` were driven in the real page; the activity hint
  moved through `Formulating`, `Thinking`, and `Stopped` and returned to
  `Ready`. Switching away from a thinking turn and back restored Markdown,
  the Mermaid diagram, and the thinking block; reconnecting mid-thought produced
  exactly one live block. `Load earlier messages` added history without losing
  scroll position. The full suite passes 490 tests.
- **Keyboard:** focus rings visible; approval traps focus and returns it; Enter
  sends and Shift+Enter breaks; slash autocomplete and command palette support
  arrows, Tab, Enter and Escape; the model overlay supports search, arrows,
  Enter and Escape; `Ctrl/Cmd+K` and `Ctrl/Cmd+O` open the palette and explorer;
  Escape denies, closes dialogs, stops a running turn, and closes the mobile
  drawer.
- **Performance (Chromium, local server):** page load to network idle ~1.1s;
  live model overlay open ~198ms; skills overlay ~37ms. A seeded 300-turn
  transcript with code, images, tools, and thinking rendered ~1,600 DOM nodes
  in the initial window instead of ~10,500 when the same history was built in
  full; the observed session switch after load was ~23ms. Mermaid diagrams
  render on approach to the viewport. 0 console errors in an isolated page.
- **Streaming:** a provider that emits 200 thinking and 200 text deltas in one
  burst presented them in 18 and 9 visible steps respectively; the final
  markdown render happens once per answer. The stream caret disappears when
  the final render settles. No entrance animation is attached to streamed text.
  Scroll updates are coalesced to one frame and respect user scroll-up.

Accepted limitation: `aria-live="polite"` on the transcript means a screen
reader may announce streamed updates; this is deliberate for a streaming
surface.
