import type { Message } from "../types.js";
import { Snapshot, type SnapshotDiff } from "./snapshot.js";

export interface UndoRecord {
  messageID: string;
  snapshot?: string;
  afterSnapshot?: string;
  files: string[];
  diff: SnapshotDiff[];
  messageCountBefore: number;
  messageCountAfter: number;
  droppedMessages?: Message[];
}

interface SessionLike {
  workspace?: string;
  messages: Message[];
  undoStack?: UndoRecord[];
  redoStack?: UndoRecord[];
  pendingSnapshot?: string;
  pendingMessageCount?: number;
}

function workspaceOf(session: SessionLike): string {
  return session.workspace ?? process.cwd();
}

function undoStack(session: SessionLike): UndoRecord[] {
  session.undoStack ??= [];
  return session.undoStack;
}

function redoStack(session: SessionLike): UndoRecord[] {
  session.redoStack ??= [];
  return session.redoStack;
}

export class UndoManager {
  async captureBefore(session: SessionLike): Promise<string | undefined> {
    const snapshot = await Snapshot.capture(workspaceOf(session));
    session.pendingSnapshot = snapshot;
    session.pendingMessageCount = session.messages.length;
    return snapshot;
  }

  async commitTurn(
    session: SessionLike,
    options: {
      before?: string;
      after?: string;
      messageCountBefore?: number;
      messageCountAfter?: number;
      messageID?: string;
    } = {},
  ): Promise<UndoRecord | undefined> {
    const before = options.before ?? session.pendingSnapshot;
    if (!before) return undefined;
    const after =
      options.after ?? (await Snapshot.capture(workspaceOf(session)));
    if (!after) return undefined;
    const workspace = workspaceOf(session);
    const record: UndoRecord = {
      messageID:
        options.messageID ??
        `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      snapshot: before,
      afterSnapshot: after,
      files: await Snapshot.files({ from: before, to: after, workspace }),
      diff: await Snapshot.diff({ from: before, to: after, workspace }),
      messageCountBefore:
        options.messageCountBefore ??
        session.pendingMessageCount ??
        session.messages.length,
      messageCountAfter: options.messageCountAfter ?? session.messages.length,
    };
    undoStack(session).push(record);
    redoStack(session).length = 0;
    session.pendingSnapshot = undefined;
    session.pendingMessageCount = undefined;
    return record;
  }

  async stage(options: {
    session: SessionLike;
    messageID: string;
    files?: string[];
    before?: string;
    after?: string;
    messageCountBefore?: number;
    messageCountAfter?: number;
  }): Promise<UndoRecord> {
    const session = options.session;
    const record = await this.commitTurn(session, options);
    if (!record) throw new Error("cannot stage undo without a snapshot");
    return record;
  }

  async undo(session: SessionLike): Promise<UndoRecord | undefined> {
    const record = undoStack(session).pop();
    if (!record) return undefined;
    if (record.snapshot && record.files.length > 0) {
      await Snapshot.restore({
        files: new Map(record.files.map((file) => [file, record.snapshot])),
        workspace: workspaceOf(session),
      });
    }
    record.droppedMessages = session.messages.slice(record.messageCountBefore);
    session.messages.length = record.messageCountBefore;
    redoStack(session).push(record);
    return record;
  }

  async redo(session: SessionLike): Promise<UndoRecord | undefined> {
    const record = redoStack(session).pop();
    if (!record) return undefined;
    if (record.afterSnapshot && record.files.length > 0) {
      await Snapshot.restore({
        files: new Map(record.files.map((file) => [file, record.afterSnapshot])),
        workspace: workspaceOf(session),
      });
    }
    if (record.droppedMessages) {
      session.messages.push(...record.droppedMessages);
    }
    undoStack(session).push(record);
    return record;
  }

  clear(session: SessionLike): void {
    undoStack(session).length = 0;
    redoStack(session).length = 0;
    session.pendingSnapshot = undefined;
    session.pendingMessageCount = undefined;
  }

  hasUndo(session: SessionLike): boolean {
    return undoStack(session).length > 0;
  }

  hasRedo(session: SessionLike): boolean {
    return redoStack(session).length > 0;
  }
}
