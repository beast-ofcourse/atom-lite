import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message } from "../types.js";
import type { SessionEvent, SessionSummary } from "./events.js";
import { isMessage, messageToEvent, eventToMessage, nowIso } from "./events.js";
import { userConfigDir } from "../config/paths.js";
import { parseJsonlEvents } from "./recovery.js";
import { acquireSessionLock, type SessionLock } from "./lock.js";
import {
  sessionMessageCount,
  sessionSearchText,
  sessionTitleFromEvents,
} from "./search.js";
import { sessionWorkspaceFromEvents } from "./history.js";

export interface Session {
  readonly id: string;
  workspace: string;
  readonly provider: string;
  messages: Message[];
  /**
   * Full event log. Durable sessions reload it from the JSONL file; the
   * in-memory session records it as messages arrive. The web client renders
   * session history from it.
   */
  events: SessionEvent[];
  appendMessage(message: Message): void;
  /** Release the one-live-owner lock, when this session holds one. */
  releaseLock?(): void;
  // Back-compat alias.
  append?(message: Message): void;
  /**
   * Durable sessions only: append a raw event to the JSONL log. Ephemeral
   * (in-memory) sessions do not implement it and callers must guard.
   */
  appendEvent?(event: unknown): void;
  /**
   * Durable sessions only: append a non-message event that must survive resume
   * even before the session's first message (for example an extension entry).
   */
  appendDurableEvent?(event: Partial<SessionEvent>): SessionEvent;
  // Flush pending durable writes (async persistence).
  flush?(): Promise<void>;
}

export class InMemorySession implements Session {
  readonly id: string;
  workspace: string;
  readonly provider: string;
  messages: Message[] = [];
  events: SessionEvent[] = [];
  private seq = 0;

  constructor(id: string, workspace: string, provider = "fake") {
    this.id = id;
    this.workspace = workspace;
    this.provider = provider;
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
    this.events.push(messageToEvent(message, this.id, ++this.seq));
  }
  append(message: Message): void {
    this.appendMessage(message);
  }
  async flush(): Promise<void> {
    // no-op
  }
}

// ---------- JSONL durable session ----------

export interface JsonlSessionOptions {
  id: string;
  workspace: string;
  provider?: string;
  filePath: string;
  events?: SessionEvent[];
  store?: JsonlSessionStoreLike;
  lock?: SessionLock;
}

export interface JsonlSessionStoreLike {
  rootDir: string;
}

function defaultDataDir(): string {
  return join(userConfigDir(), "sessions");
}

function sanitizeWorkspace(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function ensureFile(path: string): void {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, "", { mode: 0o600 });
    } catch {
      writeFileSync(path, "");
    }
  }
}

export class JsonlSession implements Session {
  readonly id: string;
  workspace: string;
  readonly provider: string;
  readonly filePath: string;
  messages: Message[] = [];
  events: SessionEvent[] = [];
  private seq: number;
  private store: any;
  private writeQueue: Promise<void> = Promise.resolve();
  private persisted = false;
  private lock?: SessionLock;

  constructor(options: JsonlSessionOptions) {
    this.id = options.id;
    this.workspace = options.workspace;
    this.provider = options.provider ?? "fake";
    this.filePath = options.filePath;
    this.store = options.store;
    this.lock = options.lock;
    this.seq = 0;

    const events = options.events ?? [];
    const resumed = events.length > 0;
    // Replay events.
    for (const ev of events) {
      this.events.push(ev);
      if (typeof ev.seq === "number" && ev.seq > this.seq) this.seq = ev.seq;
      const msg = eventToMessage(ev);
      if (msg) this.messages.push(msg);
    }

    // Ensure session_started exists.
    let started: SessionEvent | undefined;
    if (!events.some((e) => e.type === "session_started")) {
      started = {
        type: "session_started",
        timestamp: nowIso(),
        sessionId: this.id,
        seq: ++this.seq,
        workspace: this.workspace,
        provider: this.provider,
      };
      this.events.push(started);
    }

    // A resumed session already has a log on disk, so a synthesized start
    // event is written immediately. A new session stays in memory until its
    // first message, so creating one and quitting leaves no empty log.
    this.persisted = resumed;
    if (started && resumed) {
      this.persist(started);
    }
  }

  private persist(event: SessionEvent): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          ensureDir(join(this.filePath, ".."));
          ensureFile(this.filePath);
          await fsPromises.appendFile(
            this.filePath,
            JSON.stringify(event) + "\n",
            "utf8",
          );
        } catch (err) {
          console.error(
            "atom-lite: session persist failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      })
      .catch((err) => {
        console.error(
          "atom-lite: session persist queue failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  /**
   * Persist a message-bearing event. The first such event also flushes the
   * in-memory backlog (session_started plus any pre-message events) in seq
   * order, which is what brings the session file into existence.
   */
  private persistNewEvent(event: SessionEvent): void {
    if (this.persisted) {
      this.persist(event);
      return;
    }
    this.persisted = true;
    for (const pending of this.events) {
      this.persist(pending);
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  append(message: Message): void {
    this.appendMessage(message);
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
    const ev = messageToEvent(message, this.id, ++this.seq);
    this.events.push(ev);
    this.persistNewEvent(ev);
  }

  appendEvent(partial: Partial<SessionEvent>): SessionEvent {
    const ev: SessionEvent = {
      timestamp: nowIso(),
      sessionId: this.id,
      seq: ++this.seq,
      type: (partial as any).type ?? "event",
      ...partial,
    };
    // Ensure seq/timestamp/sessionId not overridden by partial? Allow partial to set? Keep ours precedence:
    ev.timestamp = (partial as any).timestamp ?? ev.timestamp;
    ev.sessionId = (partial as any).sessionId ?? this.id;
    ev.seq =
      typeof (partial as any).seq === "number" ? (partial as any).seq : ev.seq;
    this.events.push(ev);

    const msg = eventToMessage(ev);
    if (msg) {
      this.messages.push(msg);
      this.persistNewEvent(ev);
    } else if (this.persisted) {
      this.persist(ev);
    }
    return ev;
  }

  /**
   * `appendEvent` deliberately keeps non-message events in memory until the
   * first message so an unused session leaves no empty log. Extension entries
   * are different: they are state the next session must read back, so they are
   * flushed immediately even on a fresh session.
   */
  appendDurableEvent(partial: Partial<SessionEvent>): SessionEvent {
    const before = this.events.length;
    const event = this.appendEvent(partial);
    if (!this.persisted && this.events.length > before) {
      this.persistNewEvent(event);
    }
    return event;
  }

  // Convenience recorders.
  recordToolCallStarted(toolCall: any): SessionEvent {
    return this.appendEvent({
      type: "tool_call_started",
      toolCallId: toolCall?.id,
      name: toolCall?.name,
      arguments: toolCall?.arguments,
    });
  }

  recordToolResult(result: any): SessionEvent {
    return this.appendEvent({
      type: "tool_result",
      toolCallId: result?.toolCallId ?? result?.id,
      name: result?.name,
      content: result?.content,
      isError: result?.isError,
    });
  }

  recordApprovalRequested(details: any): SessionEvent {
    return this.appendEvent({ type: "approval_requested", ...details });
  }

  recordApprovalGranted(details?: any): SessionEvent {
    return this.appendEvent({ type: "approval_granted", ...(details ?? {}) });
  }

  recordApprovalDenied(details?: any): SessionEvent {
    return this.appendEvent({ type: "approval_denied", ...(details ?? {}) });
  }

  recordCompaction(summary: any): SessionEvent {
    return this.appendEvent({ type: "context_compacted", summary });
  }

  recordProviderError(error: any): SessionEvent {
    return this.appendEvent({
      type: "provider_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  end(): SessionEvent {
    const event = this.appendEvent({ type: "session_ended" });
    this.releaseLock();
    return event;
  }

  close(): SessionEvent {
    return this.end();
  }

  /** Release the live-owner lock without ending the session. */
  releaseLock(): void {
    this.lock?.release();
    this.lock = undefined;
  }
}

// ---------- Store ----------

export interface JsonlSessionStoreOptions {
  rootDir?: string;
  baseDir?: string;
  dir?: string;
  path?: string;
  workspace?: string;
  /** Grace period before a dead owner's lock is reclaimed. */
  lockReclaimMs?: number;
}

export class JsonlSessionStore {
  rootDir: string;
  private lockReclaimMs: number | undefined;

  constructor(options?: string | JsonlSessionStoreOptions) {
    if (typeof options === "string") {
      this.rootDir = options;
    } else {
      this.rootDir =
        options?.rootDir ??
        options?.baseDir ??
        options?.dir ??
        options?.path ??
        defaultDataDir();
      this.lockReclaimMs = options?.lockReclaimMs;
    }
    ensureDir(this.rootDir);
  }

  private sessionPath(id: string): string {
    return join(this.rootDir, `${id}.jsonl`);
  }

  create(...args: any[]): JsonlSession {
    let opts: any = {};
    if (typeof args[0] === "string") {
      opts.workspace = args[0];
      opts.provider = args[1];
      if (args[2]) opts.id = args[2];
    } else if (args[0] && typeof args[0] === "object") {
      opts = { ...args[0] };
    }
    const workspace = opts.workspace ?? opts.cwd ?? process.cwd();
    const provider = opts.provider ?? opts.providerProfile ?? "fake";
    const id = opts.id ?? opts.sessionId ?? randomUUID();
    const filePath = opts.filePath ?? this.sessionPath(id);

    const lock = acquireSessionLock(`${filePath}.lock`, id, {
      reclaimAfterMs: this.lockReclaimMs,
    });
    try {
      return new JsonlSession({
        id,
        workspace,
        provider,
        filePath,
        store: this,
        lock,
      });
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  createSession(...args: any[]): JsonlSession {
    return this.create(...args);
  }

  newSession(...args: any[]): JsonlSession {
    return this.create(...args);
  }

  start(...args: any[]): JsonlSession {
    return this.create(...args);
  }

  resume(id: string): JsonlSession | undefined {
    return this.resumeSession(id);
  }

  resumeSession(id: string): JsonlSession | undefined {
    const filePath = this.sessionPath(id);
    // Take the lock before checking the file: a session that is open but has
    // not written its first message has no JSONL file yet, and it must still
    // refuse a second owner.
    const lock = acquireSessionLock(`${filePath}.lock`, id, {
      reclaimAfterMs: this.lockReclaimMs,
    });
    try {
      if (!existsSync(filePath)) {
        lock.release();
        return undefined;
      }
      const events = parseJsonlEvents(filePath);
      // Derive workspace/provider from events; the newest directory change wins.
      const started = events.find((e) => e.type === "session_started") as any;
      const workspace = sessionWorkspaceFromEvents(
        events,
        typeof started?.workspace === "string"
          ? started.workspace
          : process.cwd(),
      );
      const provider = started?.provider ?? "fake";
      return new JsonlSession({
        id,
        workspace,
        provider,
        filePath,
        events,
        store: this,
        lock,
      });
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  load(id: string): JsonlSession | undefined {
    return this.resumeSession(id);
  }

  open(id: string): JsonlSession | undefined {
    return this.resumeSession(id);
  }

  get(id: string): JsonlSession | undefined {
    return this.resumeSession(id);
  }

  resumeLatest(workspace?: string): JsonlSession | undefined {
    const sessions = this.list(workspace);
    if (sessions.length === 0) return undefined;
    return this.resumeSession(sessions[0].id);
  }

  resumeMostRecent(workspace?: string): JsonlSession | undefined {
    return this.resumeLatest(workspace);
  }

  continue(workspace?: string): JsonlSession | undefined {
    return this.resumeLatest(workspace);
  }

  list(workspace?: string): SessionSummary[] {
    return this.listSessions(workspace);
  }

  listSessions(workspace?: string): SessionSummary[] {
    const out: SessionSummary[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(this.rootDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      files = [];
    }
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const filePath = join(this.rootDir, f);
      let events: SessionEvent[] = [];
      try {
        events = parseJsonlEvents(filePath);
      } catch {
        events = [];
      }
      const started = events.find((e) => e.type === "session_started") as any;
      const ws = sessionWorkspaceFromEvents(
        events,
        typeof started?.workspace === "string" ? started.workspace : "",
      );
      // A workspace-scoped listing only includes logs that prove they belong
      // to that workspace. A log with no workspace metadata is not offered
      // anywhere, rather than leaking into every workspace.
      if (workspace && ws !== workspace) continue;
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      out.push({
        id,
        workspace: ws || workspace || "",
        provider: started?.provider ?? "fake",
        createdAt: events[0]?.timestamp,
        updatedAt:
          events[events.length - 1]?.timestamp ?? stat.mtime.toISOString(),
        eventCount: events.length,
        filePath,
        title: sessionTitleFromEvents(events),
        messageCount: sessionMessageCount(events),
        searchText: sessionSearchText(events),
      });
    }
    // Sort by updatedAt desc.
    out.sort((a, b) => {
      const ta = a.updatedAt ?? "";
      const tb = b.updatedAt ?? "";
      return tb.localeCompare(ta);
    });
    return out;
  }

  recent(workspace?: string): SessionSummary[] {
    return this.listSessions(workspace);
  }

  /**
   * Delete session files last modified before `days` ago. Returns the ids
   * removed. Compaction of the directory happens in-place, newest-first tie
   * break is irrelevant (mtime decides).
   */
  pruneOldSessions(days: number): string[] {
    const cutoff = Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(this.rootDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return removed;
    }
    for (const f of files) {
      const filePath = join(this.rootDir, f);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      try {
        unlinkSync(filePath);
        // The owner lock dies with its log.
        try {
          unlinkSync(`${filePath}.lock`);
        } catch {
          // no lock, or it is already gone
        }
        removed.push(f.replace(/\.jsonl$/, ""));
      } catch {
        // A file we cannot delete now is judged during the next startup.
      }
    }
    return removed;
  }

  all(): SessionSummary[] {
    return this.listSessions();
  }

  /**
   * Delete one session log. The temporary lock refuses the delete while a
   * live owner (the TUI or another server) holds the session.
   */
  deleteSession(id: string): boolean {
    const filePath = this.sessionPath(id);
    if (!existsSync(filePath)) return false;
    const lock = acquireSessionLock(`${filePath}.lock`, id);
    try {
      if (!existsSync(filePath)) return false;
      unlinkSync(filePath);
      return true;
    } finally {
      lock.release();
    }
  }

  appendEvent(
    sessionId: string,
    partial: Partial<SessionEvent>,
  ): SessionEvent | undefined {
    const session = this.resumeSession(sessionId);
    if (!session) return undefined;
    return session.appendEvent(partial);
  }

  append(sessionId: string, partial: any): any {
    return this.appendEvent(sessionId, partial);
  }
}

// Aliases for compatibility.
export const SessionStore = JsonlSessionStore;
export const FileSessionStore = JsonlSessionStore;
export const DurableSessionStore = JsonlSessionStore;
export const PersistentSessionStore = JsonlSessionStore;

export const DurableSession = JsonlSession;
export const FileSession = JsonlSession;
export const PersistentSession = JsonlSession;

// Back-compat: a "store" default export not needed.
