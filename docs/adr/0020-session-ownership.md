# 0020 — One live owner per session

Date: 2026-11-16
Status: Accepted (implemented on branch `web-ui`, ticket 08)
Supersedes: none
Related: 0019 (web surface)

## Context

A session is an append-only JSONL log. The terminal writes to it and the
browser server (`atom-lite --serve`, ADR 0019) writes to the same file, so two
live processes can now drive one session at the same time. That is not a
theoretical problem: both writers append events with their own sequence
numbers, both replay the log into their own context, and both answer approval
prompts. The result is an interleaved log, duplicated turns, and a transcript
that no longer matches what either surface saw.

The terminal already refuses to resume a session in use by another terminal
process in some paths, but that check was ad hoc and the web server had no
equivalent.

## Decision

Ownership is a lock file next to the log: `<sessionId>.jsonl.lock`, holding the
owner's PID, hostname, and start time.

- **Acquisition.** `JsonlSessionStore.create` and `resumeSession` acquire the
  lock through `src/sessions/lock.ts`. The file is created with `O_EXCL`, so
  exactly one process wins the race.
- **Refusal.** A lock held by a live process raises `SessionLockError`, whose
  message names the holder's PID and host. The CLI prints it and exits with
  status 1, the TUI reports it in the transcript, and the web server returns
  it to the browser as the reason the session could not be opened.
- **Same-process re-entry.** The terminal may reopen a session it already
  holds. Re-entry is ref-counted inside the process, so the file survives until
  the last session object releases it.
- **Release.** Locks are released when a session ends or closes, when the
  surface switches to another session, when the web server shuts down, and by
  a process-exit hook.
- **Crash recovery.** A killed process cannot release its lock. A lock whose
  PID is no longer alive is reclaimed after a short grace period (250 ms by
  default) so a restart does not race a just-dying process. The holder is
  re-read after that grace, so a lock that was still being written is never
  unlinked from under a live owner.

## Rationale

- **A lock file over an OS advisory lock.** `flock`/`fcntl` locks are
  per-machine and disappear with the process, but they are invisible to the
  user, cannot say who holds the session, and behave differently across
  platforms. A file with a PID can be inspected, named in the error, and
  reclaimed after a crash.
- **PID liveness over file age.** A lock file's age says nothing about whether
  its owner is alive. The PID does, and the grace period covers the window
  where a process is dying but still has the file open.
- **Failure closed.** When ownership cannot be established, the request is
  refused with a reason. Two writers are worse than one writer that says no.

## Consequences

- The mechanism assumes one machine. It does not lock a session across hosts,
  and the hostname in the lock is informational only.
- PID reuse can make a dead owner look alive; the reclaim path then waits for
  the grace period and tries again.
- Reclaiming a dead lock briefly blocks the caller (the grace period). This
  is a startup path, not a hot loop.
- The lock is per session, not per workspace: two different sessions can be
  open in two processes without interfering.
- Every durable session now has a sibling `.lock` file next to it. Listing
  and pruning only consider `*.jsonl`, and pruning a session removes its lock
  with it.
