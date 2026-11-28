# 0026 — Streaming media reads

Date: 2026-11-28
Status: Accepted
Related: 0025 (web workbench), 0023 (read tool paging)

## Context

ADR 0025 gave the web workbench a token-guarded `/file` read with a 20 MB cap.
The workbench now previews video, audio, and Office documents. Loading those
through `/file` would either exhaust the cap or force the whole file into
memory before playback or rendering, and it would make byte-range seeking
impossible. Office engines are large packages that must not be fetched at
startup, and serving them from a CDN would break the local-first and
same-origin rules.

## Decision

Video and audio read through a second, bounded endpoint, `/media`. It requires
the run token, rejects foreign origins and hosts, resolves the path inside the
workspace, rejects symlinks that leave it, and allowlists media extensions. A
file larger than 256 MB is refused. The endpoint supports byte ranges, returns
206 for a partial read and 416 for an invalid range, emits validators so the
browser can reuse a ranged read within the session, and sets `no-store`,
`nosniff`, and a restrictive content-security policy on every response.

Other files that need a full byte stream, including Office documents and
unsupported binaries, read through `/download`. It applies the same token,
origin, containment, symlink, size, no-store, no-sniff, and content-policy
guards, and sets an attachment disposition. Ordinary text and code reads keep
the existing 20 MB `/file` cap; HTML and SVG are still served as text.

Office engines are pinned runtime dependencies served from a strict same-origin
allowlist under `/engine`. Only the listed `@betteroffice` packages and their
`dist/` or `assets/` subtrees are reachable; paths are decoded and checked
against traversal, and responses carry the same no-store, no-sniff, and
content-policy headers. Each format's engine is imported lazily by its own
module worker when a matching file opens, and the worker ends with its tab.
Worker-generated markup is drawn to canvases or built as DOM nodes, never
injected as HTML.

On tab restore the workbench probes each tab with the route its kind uses: a
one-byte Range GET for video and audio, a GET for Office and binary files, and
a GET for text. Each probe cancels the response body as soon as headers
arrive, and a tab whose file is gone is skipped. A negative probe never
removes a file; the streams only answer whether the guarded read would work.

## Consequences

- A session that never opens media or Office documents pays no streaming or
  engine cost beyond the installed packages.
- The 256 MB media bound is separate from the 20 MB read cap. Large media can
  be previewed but cannot be attached to a prompt, which keeps the composer
  contract unchanged.
- Every new read path repeats the containment and header guards, so changes to
  workspace confinement must be applied to `/file`, `/media`, `/download`, and
  `/engine` together.
- Installing the engines adds roughly 65 MB unpacked to the package. Full
  Office coverage was chosen deliberately over a lighter subset.
- Ranged reads and engine modules are never cached on disk; the browser may
  reuse a validator within a session only.

## Alternatives considered

- **Read media through `/file` and raise its cap.** Rejected: it would remove
  the cheap cap for ordinary reads, still load the whole file, and provide no
  byte-range seeking.
- **Copy Office engines into `web/vendor/`.** Rejected: it duplicates pinned
  dependencies and loses the explicit version contract.
- **Load engines from a CDN.** Rejected: it violates the local-first,
  same-origin, and no-remote-script rules.
- **Skip existence probes on restore.** Rejected: stale media and Office tabs
  would stay open and show an error instead of being skipped like text tabs.
