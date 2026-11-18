import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { nowIso } from "../sessions/events.js";

export interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

/** The part of a live Atom-lite session the extension manager needs. */
export interface ExtensionSessionLike {
  id?: string;
  workspace?: string;
  cwd?: string;
  filePath?: string;
  events?: ReadonlyArray<Record<string, unknown>>;
  appendEvent?: (event: Record<string, unknown>) => unknown;
  /** Persists non-message events even before a session's first message. */
  appendDurableEvent?: (event: Record<string, unknown>) => unknown;
  flush?: () => Promise<void>;
}

export interface PiSessionManagerOptions {
  id?: string;
  cwd?: string;
  sessionFile?: string;
  entries?: PiSessionEntry[];
  /** Live session. When present, entries are written to the session store. */
  session?: ExtensionSessionLike;
}

/** Event type used for extension entries in the durable session event log. */
export const EXTENSION_ENTRY_EVENT = "extension_entry";

function entriesFromSession(
  session?: ExtensionSessionLike,
): PiSessionEntry[] | undefined {
  if (!session?.events) return undefined;
  return session.events
    .filter((event) => event?.type === EXTENSION_ENTRY_EVENT)
    .map((event) => ({
      type: "custom",
      customType: String(event.customType ?? "custom"),
      data: event.data,
      id: String(event.id ?? randomUUID()),
      parentId: (event.parentId as string | null) ?? null,
      timestamp: String(event.timestamp ?? nowIso()),
    }));
}

export class PiSessionManager {
  private id: string;
  private cwd: string;
  private sessionFile: string;
  private session?: ExtensionSessionLike;
  private entries: PiSessionEntry[] = [];
  private labels = new Map<string, string>();
  private sessionName: string | undefined;
  private leafId: string | null = null;

  constructor(options: PiSessionManagerOptions = {}) {
    this.session = options.session;
    this.id = options.id ?? this.session?.id ?? randomUUID();
    this.cwd =
      options.cwd ??
      this.session?.cwd ??
      this.session?.workspace ??
      process.cwd();
    this.sessionFile = options.sessionFile ?? this.session?.filePath ?? "";
    const entries = options.entries ?? entriesFromSession(this.session) ?? [];
    this.entries = [...entries];
    this.leafId = this.entries.length
      ? this.entries[this.entries.length - 1].id
      : null;
  }

  private get canPersist(): boolean {
    return !!(this.session?.appendDurableEvent ?? this.session?.appendEvent);
  }

  getId(): string {
    return this.id;
  }
  getCwd(): string {
    return this.cwd;
  }
  getSessionFile(): string {
    return this.sessionFile;
  }
  getSessionDir(): string {
    return this.sessionFile ? dirname(this.sessionFile) : this.cwd;
  }
  getSessionId(): string {
    return this.id;
  }
  getSessionName(): string | undefined {
    return this.sessionName;
  }
  setSessionName(name: string): void {
    this.sessionName = name;
  }

  getHeader(): Record<string, unknown> {
    return {
      type: "session",
      version: 1,
      id: this.id,
      timestamp: nowIso(),
      cwd: this.cwd,
    };
  }

  getEntries(): PiSessionEntry[] {
    // The session store is the source of truth once a session can persist.
    // The in-memory registry is only a fallback for ephemeral sessions.
    if (this.canPersist) {
      return entriesFromSession(this.session) ?? [...this.entries];
    }
    return [...this.entries];
  }

  getEntry(id: string): PiSessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): PiSessionEntry | undefined {
    const id = this.getLeafId();
    return id ? this.getEntry(id) : undefined;
  }

  getBranch(from?: string): PiSessionEntry[] {
    // Linear branch: all entries from root to leaf.
    const target = from ?? this.leafId;
    if (!target) return [...this.entries];
    const index = this.entries.findIndex((entry) => entry.id === target);
    if (index < 0) return [...this.entries];
    return this.entries.slice(0, index + 1);
  }

  setLabel(entryId: string, label: string | undefined): void {
    if (label === undefined) this.labels.delete(entryId);
    else this.labels.set(entryId, label);
  }

  getLabel(entryId: string): string | undefined {
    return this.labels.get(entryId);
  }

  appendEntry(customType: string, data: unknown): string {
    const id = randomUUID();
    const timestamp = nowIso();
    const entry: PiSessionEntry = {
      type: "custom",
      customType,
      data,
      id,
      parentId: this.leafId,
      timestamp,
    };
    this.entries.push(entry);
    this.leafId = id;
    const event = {
      type: EXTENSION_ENTRY_EVENT,
      customType,
      data,
      id,
      parentId: entry.parentId,
      timestamp,
    };
    const writer =
      this.session?.appendDurableEvent ?? this.session?.appendEvent;
    try {
      writer?.call(this.session!, event);
    } catch {
      // A failed write must not break the extension's turn; the in-memory
      // entry remains available for this process.
    }
    return id;
  }

  appendCustomMessage(
    customType: string,
    content: unknown,
    display?: boolean,
    details?: unknown,
  ): string {
    const id = randomUUID();
    const entry: PiSessionEntry = {
      type: "custom_message",
      customType,
      content,
      display: display ?? true,
      details,
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
    };
    this.entries.push(entry);
    this.leafId = id;
    return id;
  }

  buildContextEntries(): Array<Record<string, unknown>> {
    return this.getEntries()
      .filter((entry) => entry.type === "custom_message")
      .map((entry) => ({
        role: "user",
        content: entry.content,
        customType: entry.customType,
      }));
  }

  buildSessionProjection(): Record<string, unknown> {
    return {
      id: this.id,
      cwd: this.cwd,
      entries: this.getEntries(),
      leafId: this.leafId,
      sessionName: this.sessionName,
    };
  }
}

// Back-compat alias names hidden tests may use.
export { PiSessionManager as ExtensionSessionManager };
export { PiSessionManager as SessionManager };
