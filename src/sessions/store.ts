import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message } from "../types.js";
import type { SessionEvent, SessionSummary } from "./events.js";
import { isMessage, messageToEvent, eventToMessage, nowIso } from "./events.js";
import { parseJsonlEvents } from "./recovery.js";

export interface Session {
  readonly id: string;
  readonly workspace: string;
  readonly provider: string;
  messages: Message[];
  appendMessage(message: Message): void;
  // Back-compat alias.
  append?(message: Message): void;
}

export class InMemorySession implements Session {
  readonly id: string;
  readonly workspace: string;
  readonly provider: string;
  messages: Message[] = [];

  constructor(id: string, workspace: string, provider = "fake") {
    this.id = id;
    this.workspace = workspace;
    this.provider = provider;
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
  }
  append(message: Message): void {
    this.appendMessage(message);
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
}

export interface JsonlSessionStoreLike {
  rootDir: string;
}

function defaultDataDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "atom-lite", "sessions");
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

export class JsonlSession {
  readonly id: string;
  readonly workspace: string;
  readonly provider: string;
  readonly filePath: string;
  messages: Message[] = [];
  events: SessionEvent[] = [];
  private seq: number;
  private store: any;

  constructor(options: JsonlSessionOptions) {
    this.id = options.id;
    this.workspace = options.workspace;
    this.provider = options.provider ?? "fake";
    this.filePath = options.filePath;
    this.store = options.store;
    this.seq = 0;

    const events = options.events ?? [];
    // Replay events.
    for (const ev of events) {
      this.events.push(ev);
      if (typeof ev.seq === "number" && ev.seq > this.seq) this.seq = ev.seq;
      const msg = eventToMessage(ev);
      if (msg) this.messages.push(msg);
    }

    // Ensure session_started exists.
    if (!events.some((e) => e.type === "session_started")) {
      const ev: SessionEvent = {
        type: "session_started",
        timestamp: nowIso(),
        sessionId: this.id,
        seq: ++this.seq,
        workspace: this.workspace,
        provider: this.provider,
      };
      this.events.push(ev);
      this.persist(ev);
    }
  }

  private persist(event: SessionEvent): void {
    try {
      ensureDir(join(this.filePath, ".."));
      ensureFile(this.filePath);
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Best effort.
    }
  }

  append(message: Message): void {
    this.appendMessage(message);
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
    const ev = messageToEvent(message, this.id, ++this.seq);
    this.events.push(ev);
    this.persist(ev);

    // Emit tool_call_started events for assistant tool calls.
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const tc of message.toolCalls) {
        const ev2: SessionEvent = {
          type: "tool_call_started",
          timestamp: nowIso(),
          sessionId: this.id,
          seq: ++this.seq,
          toolCallId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
        this.events.push(ev2);
        this.persist(ev2);
      }
    }
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
    if (msg) this.messages.push(msg);

    this.persist(ev);
    return ev;
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
    return this.appendEvent({ type: "session_ended" });
  }

  close(): SessionEvent {
    return this.end();
  }
}

// ---------- Store ----------

export interface JsonlSessionStoreOptions {
  rootDir?: string;
  baseDir?: string;
  dir?: string;
  path?: string;
  workspace?: string;
}

export class JsonlSessionStore {
  rootDir: string;

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

    const session = new JsonlSession({
      id,
      workspace,
      provider,
      filePath,
      store: this,
    });
    return session;
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
    if (!existsSync(filePath)) return undefined;
    const events = parseJsonlEvents(filePath);
    if (events.length === 0) {
      // still return empty session
    }
    // Derive workspace/provider from first session_started event.
    const started = events.find((e) => e.type === "session_started") as any;
    const workspace = started?.workspace ?? process.cwd();
    const provider = started?.provider ?? "fake";
    return new JsonlSession({
      id,
      workspace,
      provider,
      filePath,
      events,
      store: this,
    });
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
      const ws = started?.workspace ?? "";
      if (workspace && ws && ws !== workspace) continue;
      const stat = statSync(filePath);
      out.push({
        id,
        workspace: ws || workspace || "",
        provider: started?.provider ?? "fake",
        createdAt: events[0]?.timestamp,
        updatedAt:
          events[events.length - 1]?.timestamp ?? stat.mtime.toISOString(),
        eventCount: events.length,
        filePath,
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

  all(): SessionSummary[] {
    return this.listSessions();
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

// Back-compat: a "store" default export not needed.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Wait, `export const JsonlSessionStore = JsonlSessionStore;` self-reference in same scope? That's invalid (const redefinition). Need remove self alias. Let's fix: only alias other names. Remove self line.<|end|><|start|>artist to=edit<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
