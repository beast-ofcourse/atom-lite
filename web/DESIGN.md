# Web surface design system

Surface mode: **Operate**. The browser is a task surface for the same local
agent as the terminal. It should read as a precise tool, not a demo: calm
neutrals, one accent, dense but readable spacing, and conventional controls.

The terminal UI is the incumbent evidence. The web palette is a translation of
its semantic tokens (`text`, `dim`, `accent`, `success`, `warning`, `error`,
`border`, `code`) into a browser scale, not a second brand.

## Tokens

All values live in `styles.css` as custom properties on `:root`, with a
`[data-theme="light"]` override block. Components use tokens only.

### Colour

| Token               | Dark                         | Light                            | Use                           |
| ------------------- | ---------------------------- | -------------------------------- | ----------------------------- |
| `--bg`              | `#0f1116`                    | `#f6f7f9`                        | page ground                   |
| `--bg-raised`       | `#171a21`                    | `#ffffff`                        | cards, composer, user message |
| `--hover`           | `#1d222b`                    | `#eef1f5`                        | control hover                 |
| `--border`          | `#2a303b`                    | `#d9dee6`                        | separators, card edges        |
| `--border-strong`   | `#5f6773`                    | `#8a8f98`                        | control edges, scrollbar      |
| `--text`            | `#e8ebf0`                    | `#1b2029`                        | body and headings             |
| `--text-dim`        | `#9aa3b2`                    | `#5a6373`                        | secondary copy, metadata      |
| `--text-faint`      | `#7c8595`                    | `#5f6a7a`                        | role labels                   |
| `--accent`          | `#5aa2f8`                    | `#0b63c5`                        | links, tool names, primary    |
| `--accent-contrast` | `#0b0d12`                    | `#ffffff`                        | text on accent                |
| `--ok`              | `#4cbd8a`                    | `#1f7a4d`                        | success, control badge        |
| `--warn`            | `#e2b25a`                    | `#8a5a00`                        | running, viewer badge, queued |
| `--err`             | `#ef7f7f`                    | `#b3261e`                        | failures                      |
| `--focus`           | `#7db8ff`                    | `#0b63c5`                        | keyboard focus ring           |
| `--code-bg`         | `#0b0e13`                    | `#f1f4f8`                        | fenced code, approval command |
| `--inline-bg`       | `#1d222b`                    | `#e9edf3`                        | inline code                   |
| `--overlay`         | `rgba(6,8,12,.66)`           | `rgba(24,32,46,.36)`             | modal scrim                   |
| `--selection`       | `rgba(90,162,248,.3)`        | `rgba(11,99,197,.18)`            | text selection                |
| `--shadow`          | `0 18px 48px rgba(0,0,0,.5)` | `0 18px 48px rgba(24,32,46,.16)` | dialog elevation              |

Measured contrast on the page ground (WCAG 2.1 ratios):

| Pair                                  | Dark            | Light           |
| ------------------------------------- | --------------- | --------------- |
| `--text` on `--bg`                    | 15.8            | 15.2            |
| `--text-dim` on `--bg`                | 7.4             | 5.7             |
| `--text-faint` on `--bg`              | 5.1             | 5.1             |
| `--accent` on `--bg`                  | 7.2             | 5.4             |
| `--accent-contrast` on accent         | 7.4             | 5.8             |
| `--ok` / `--warn` / `--err` on `--bg` | 8.1 / 9.7 / 7.2 | 5.0 / 5.5 / 6.1 |
| `--border-strong` on `--bg`           | 3.3             | 3.0             |

Text, status, and code copy clear 4.5:1 everywhere. `--border` is a quiet
separation line (1.4:1 dark, 1.3:1 light) and carries no state on its own;
every boundary that accepts input or marks a control uses `--border-strong`
(≥3:1) and focus rings are 2px solid `--focus`. Accent is used for one job at
a time, never as a field.

### Syntax

`--syntax-comment`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`,
`--syntax-title`, `--syntax-attr`, `--syntax-builtin`, `--syntax-literal`, and
`--syntax-type` are defined per theme. highlight.js emits the class names; the
stylesheet owns the colour, so there is no vendored highlight CSS.

### Type

System sans for interface copy and markdown prose; system mono for code, tool
names, paths, and metadata.

| Token         | Size   | Use                           |
| ------------- | ------ | ----------------------------- |
| `--text-xs`   | 11px   | role labels, status, metadata |
| `--text-sm`   | 12.5px | tool summary, secondary UI    |
| `--text-base` | 14px   | body, composer                |
| `--text-md`   | 15px   | empty-state title             |

Markdown headings scale inside the message (1.4 / 1.22 / 1.08 / 1em), so a
reply never turns into a page title. Body measure is capped by the 880px app
column and 76ch for user bubbles.

### Space, radius, motion

`--space-1..6` = 4, 8, 12, 16, 24, 32 px. `--radius-xs/sm/md/lg` = 5, 6, 10,
14 px, with `--radius-pill` for chips and scrollbars. `--cap-output` (320px)
and `--cap-input` (220px) bound the tool output and composer growth. One
easing (`--ease`) for 120ms hover and disclosure transitions. Under
`prefers-reduced-motion: reduce`, transitions collapse to near-zero.

## Components

- **Top bar.** Brand dot, provider/model metadata, workspace session picker,
  and one role chip: `controlling` (success) or `read-only viewer` (warning).
  The chip is the only place control state is written.
- **Transcript.** Left-aligned messages. User prompts are raised panels; agent
  replies are unframed prose so headings and code keep the page's rhythm.
  Tool cards and thinking blocks sit between prose blocks in event order.
- **Markdown.** Rendered from model text with markdown-it (`html: false`):
  headings, lists, links (new tab, `rel="noreferrer noopener"`), tables,
  blockquotes, rules, inline code, fenced code. Links use the accent with a
  2px offset underline.
- **Code.** Fenced blocks use the sunken code ground, a 10px radius, mono at
  `--text-sm`, and horizontal scroll. The vendored highlight.js is optional:
  if the library is missing or a fence names an unknown language, markdown-it
  escapes the code and it remains readable as plain text.
- **Thinking.** A collapsed `<details>` panel with a drawn chevron, raised
  ground, secondary copy, and no left rule. It is visually subordinate to
  assistant prose and never pretends to be an answer.
- **Tool card.** Name, one-line argument summary, state (`running`, `done`,
  `failed`), then a scrollable output tail capped at 60k chars / 400 lines
  with an "earlier lines" marker. Result content fills the body when the tool
  emitted no live output; diffs append in a second block.
- **Approval.** Centered dialog with a shadow-only elevation (no decorative
  border), tool chip, command block, cwd, and Approve / Deny / Trust session.
  Only the controlling tab can answer.
- **Composer.** Textarea that grows to 220px, Enter sends, Shift+Enter breaks.
  Queued messages appear above it as `queued:` rows, one per message.
- **Browser surfaces.** Selection, focus rings, scrollbars, caret, and link
  underlines are themed; disabled controls dim rather than disappear.

## Theme mapping

The server maps the configured terminal theme onto this surface:

- `light`, `solarized`, `ansi`, or `--no-color` / `NO_COLOR` → **light**
- every other theme (`dark`, `dracula`, `monokai`, `nord`, `auto` resolved
  dark) → **dark**

The resolved value is injected as `<html data-theme="…">` when the page is
served. There is no in-page theme switch: the terminal config is the source of
truth. `color-scheme` follows the theme so native form controls and scrollbars
match.

## Session history

The durable JSONL log stores messages and tool results. Transient detail —
thinking deltas and live tool output — lives in the in-flight replay buffer
only. A reconnect during a turn therefore restores the turn exactly, including
its thinking and tool tails, while a turn that finished while the page was
away comes back as its messages and tool results. The terminal resumes a
session the same way.

## Vendored assets

- `vendor/markdown-it.min.js` — markdown-it 15.0.3, MIT
  (`vendor/LICENSE.markdown-it.txt`)
- `vendor/highlight.min.js` — highlight.js 11.12.0 (cdn-assets build), BSD-3
  (`vendor/LICENSE.highlight.js.txt`)

Both are served by the local server with the same per-run token as every other
asset. There is no build step. Model text is never trusted as HTML.

## Decisions

- No gradients, glass, glow, or colored card rules; hierarchy comes from
  spacing, weight, and one accent.
- Tool output stays monospace and unwrapped from markdown: logs are data.
- The transcript is one column at every width; no sidebars or card grids.
- Status is text plus colour, never colour alone.
- New surfaces should reuse these tokens and add a token before adding a
  one-off value.
