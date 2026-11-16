# 0019 — Web surface (`atom-lite --serve`)

Date: 2026-11-16
Status: Accepted (implemented on branch `web-ui`, tickets 01–12)
Supersedes: none

## Context

The runtime, tools, sessions, and approval semantics were terminal-only. Users
asked for a browser surface for the same local agent: a second view on one
workspace, not a hosted product or a second agent implementation. A browser UI
could easily become a divergent runtime (its own loop, its own session store,
its own approval rules), which is exactly the failure mode this project avoids.

Two constraints shaped the design:

- **One runtime.** The browser must drive the same `AgentRuntime`, built-in
  tools, bash process handling, and JSONL sessions as the TUI. Anything else
  forks the product.
- **Local-first exposure.** The server must not become a network service by
  default: no auth provider, no account, no remote bind.

## Decision

Add a server mode that owns the same runtime the TUI uses and serves a
zero-build browser client.

- **Transport.** A Node `http` server plus `ws` (`8.23.0`, pinned) carries JSON
  messages. `ws` is the only new runtime dependency. The client is vanilla
  HTML/CSS/JS under repo-root `web/`, shipped in the npm package; there is no
  frontend build step.
- **Command.** `atom-lite --serve [port]` listens on `127.0.0.1` (default port
  `7317`), walks to the next free port on `EADDRINUSE`, prints the URL, and
  opens the browser.
- **Exposure.** A random per-run token is embedded in the served page and in
  every asset URL; HTTP and WebSocket requests must present it. Requests with a
  foreign `Origin` or `Host` are rejected (localhost CSRF and DNS rebinding).
  `--host` stays out of scope.
- **Runtime events.** `AgentRuntime.setEventSink` lets the server (or the TUI)
  own the single event stream. The runtime gains only additive seams for the
  browser: `setEventSink`, `setWorkspace`, an optional `tool` on
  `ApprovalRequest`, and an optional `resetTrust` on `ApprovalContext`. The
  loop, tool behavior, and scheduling are unchanged.
- **Approvals.** The server installs itself as the approval handler; requests
  go to the browser with the command, cwd, tool, and the waiting turn id.
  Approve/deny/trust-session map onto the existing `ApprovalContext`; trust is
  memory-only for this server process. A pending request survives a brief
  disconnect and is handed to the reconnecting controller; if nobody returns
  within the grace period it fails safe as a denial, so a disconnect can
  neither strand a turn nor grant permission nobody gave.
- **Sessions.** The server keeps the CLI's `JsonlSessionStore` and switches the
  active session on `new_session` / `resume_session`. Listings are filtered to
  the server workspace and reuse the same `<sessionId>.jsonl` logs the TUI
  reads and writes. Switching is refused while a turn is running.
- **Tabs.** The first connection controls input and approvals; later tabs are
  read-only viewers and receive a banner; control passes to the next client
  when the controller leaves.
- **Mid-turn input.** Messages sent while a turn runs go into the runtime's
  steering queue and are appended between model iterations; `turn_end` is sent
  only after that queue drains.

## Consequences

- The web server is a thin adapter: it must not grow its own loop, tool
  execution, or session format. Failures belong in the runtime or the client.
- The token/Origin checks are the security boundary. Binding `0.0.0.0`,
  disabling the token, or embedding the token in a cross-origin page would
  break the model and requires a new ADR.
- The client is untyped browser JS by necessity; the wire protocol is typed
  server-side in `src/web/protocol.ts`, which is the contract to keep in sync.
- Reconnect replay is an active-turn buffer, not a second session format. The
  server slices session history to before the turn, sends the buffered runtime
  events with the turn's prompts on connect, and releases the buffer at
  `turn_end`. Completed turns stay readable from the JSONL log.
- Session ownership is a `<sessionId>.jsonl.lock` file containing the holder's
  PID and host (ADR 0020). Both the CLI and the server acquire it through
  `src/sessions/lock.ts`; a live holder refuses with its PID, and a lock whose
  PID is gone is reclaimed after a short grace period. This is process
  ownership, not a distributed lock: it assumes one machine.
- Protocol tests in `tests/web/protocol.test.ts` are the regression net for
  token enforcement, stream ordering, tool-card events, approvals, sessions,
  multi-tab control, mid-turn input, and reconnect replay. There is no
  browser-test dependency for v1. Session ownership has its own cross-process
  test in `tests/sessions/ownership.test.ts`.
