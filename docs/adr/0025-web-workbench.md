# 0025 — Web workbench

Date: 2026-11-27
Status: Accepted
Related: 0024 (web surface parity), 0023 (read tool paging), 0026 (streaming media reads)

## Context

ADR 0024 made the browser an observe + steer surface and deferred ANSI
rendering, shell mode, extension widgets, tool-specific TUI chrome, and the
unbuilt visualizer until a later ADR reversed them. That held while the browser
offered a conversation and a task ledger. The right-hand workbench now owns a
workspace tree, file tabs with previews and explicit editing, a diff review tab,
and terminal tabs. Those tabs need the capabilities ADR 0024 deferred. The
reversal must be scoped: the rest of the browser still follows ADR 0024, and the
extension widgets and visualizer deferrals were not asked for and stay in force.

A pseudo-terminal also changes the approval boundary. The agent shell tool
approves discrete command arguments. A PTY carries raw bytes in both directions,
with no command boundary visible to the server.

## Decision

ADR 0024's deferrals of shell mode, ANSI rendering, and tool-specific TUI chrome
are reversed for the right-hand workbench only. The dock may host a PTY-backed
terminal tab with ANSI colour rendering, a workspace tree with file tabs, and a
diff review tab with its own chrome. Extension widgets and the unbuilt
visualizer stay deferred. Turn handling, agent tools, session logs, the
composer outside the `@` picker, and the terminal surface outside the web dock
are unchanged.

Workspace files may be edited from a file tab. Previews stay read-only until the
user enters edit mode. A save carries a run token and the revision from the
loaded file; the server rejects stale revisions, paths outside the workspace,
disallowed extensions and sizes, plan mode, read-only viewers, and foreign
origins or hosts. Reads use the same token, containment, and allowlist guards,
serve HTML and SVG as text, and set no-store and no-sniff headers. Browser
storage holds tab layout and annotations only; file edits go to the guarded
write endpoint. ADR 0026 adds the bounded streaming path for media and the
same-origin asset route for Office engines without changing this rule.

Each terminal tab owns one PTY-backed shell with the workspace as its working
directory. The workbench supports several concurrent shells up to a cap, ANSI
colour output, input and Ctrl+C, resize messages for full-screen programs, and a
bounded output buffer. A shell ends when its tab closes, the socket closes, or
the server shuts down.

Opening a terminal requires the same approval dialog and persona checks as the
agent's shell tool. Approval is granted per shell session, not per command: a
PTY cannot tell the server where one command ends and the next begins. A shell
may run pipelines, spawn child processes, and enter interactive programs that
consume raw keystrokes and emit control sequences. Inferring commands from the
byte stream would be unreliable and would break those programs. The approved
session is bounded instead by one shell, its workspace working directory, the
session count cap, and teardown on tab, socket, or server close. Workspace
confinement of an interactive shell is a documented limitation, not a
guarantee. Plan mode and read-only viewers are refused a terminal.

Outside the workbench the browser remains an observe + steer surface under ADR
0024. Shell mode, file editing, and tool-specific chrome are not added to the
conversation, the task ledger, or any other browser view. The `@` picker in the
composer is an existing attachment path used to steer the next prompt, not a new
editing or shell capability.

## Consequences

- The deferral lines in ADR 0024 stop blocking the workbench implementation.
  They still bind every browser surface outside the dock, and the extension
  widget and visualizer deferrals remain open.
- The approval dialog must describe session scope. Once a terminal opens, the
  user can type any command into that shell without a new prompt; the
  controller, plan-mode, and read-only checks happen at open time.
- The PTY backend is a native dependency that must build on every supported
  platform. Pipe-backed shells cannot replace it without losing interactive
  programs, correct resize behaviour, and Ctrl+C.
- Terminal count, scrollback, and per-tab history are capped, and every shell is
  torn down on tab close, socket close, and shutdown, so a browser session
  cannot leave unbounded processes or memory behind.
- Browser edits write workspace files, so stale-write rejection and the
  permission guards are part of the safety boundary, not conveniences. Layout
  state and PDF annotations do not move into the workspace.
- Public documentation needs a section for the dock, its tabs, and the `@`
  picker when the workbench ships. This ADR is private and changes no published
  page.

## Alternatives considered

- **Keep ADR 0024's deferral and send users to the terminal surface.**
  Rejected: it blocks the working rhythm the workbench is meant to provide and
  leaves the browser unable to inspect or correct the workspace it discusses.
- **Approve each command by parsing PTY output.** Rejected: command boundaries
  are not observable in a byte stream, pipelines and child processes defeat
  parsing, and withholding input would break full-screen interactive programs.
- **Emulate a shell with a pipe and browser-side ANSI renderer.** Rejected: no
  real TTY means incorrect resize, job control, and Ctrl+C behaviour.
- **Store edits in browser storage without a revision guard.** Rejected: a
  stale tab could overwrite a later change, and the browser would bypass plan
  mode and read-only permissions.
- **Make the whole browser a pixel-parity TUI.** Rejected: it costs more than
  the session-state parity ADR 0024 protects and contradicts that decision
  outside the dock.
