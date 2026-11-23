import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SnapshotDiff {
  path: string;
  file: string;
  diff: string;
  patch: string;
}

export interface SnapshotRestoreInput {
  files: Map<string, string | undefined>;
  workspace?: string;
}

export interface SnapshotDiffInput {
  from: string;
  to: string;
  paths?: string[];
  workspace?: string;
}

export interface SnapshotFilesInput {
  from: string;
  to: string;
  workspace?: string;
}

export class Snapshot {
  readonly workspace: string;

  constructor(workspace?: string) {
    this.workspace = workspace ?? process.cwd();
  }

  async capture(): Promise<string | undefined> {
    const cwd = this.workspace;
    const tmpIndex = path.join(
      tmpdir(),
      `atom-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        // best effort
      }
      execFileSync("git", ["read-tree", "--empty"], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["add", "-A"], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const tree = execFileSync("git", ["write-tree"], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim();
      return tree || undefined;
    } catch {
      return undefined;
    } finally {
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        // best effort
      }
    }
  }

  async restore(input: { files: Map<string, string | undefined> }): Promise<void> {
    const cwd = this.workspace;
    const root = path.resolve(cwd);
    for (const [relativePath, treeId] of input.files) {
      const rel = relativePath.replace(/^\.?\//, "");
      const abs = path.resolve(cwd, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;
      if (!treeId) {
        try {
          rmSync(abs, { recursive: true, force: true });
        } catch {
          // best effort
        }
        continue;
      }
      let restored = false;
      try {
        execFileSync(
          "git",
          ["restore", "--source", treeId, "--worktree", "--", rel],
          {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        restored = true;
      } catch {
        try {
          execFileSync("git", ["checkout", treeId, "--", rel], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          restored = true;
        } catch {
          restored = false;
        }
      }
      if (!restored) {
        try {
          rmSync(abs, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  async diff(input: {
    from: string;
    to: string;
    paths?: string[];
  }): Promise<SnapshotDiff[]> {
    const cwd = this.workspace;
    const args = ["diff", "--no-color", input.from, input.to];
    if (input.paths && input.paths.length > 0) {
      args.push("--", ...input.paths);
    }
    let output = "";
    try {
      output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error: any) {
      output = typeof error?.stdout === "string" ? error.stdout : "";
    }
    const result: SnapshotDiff[] = [];
    const chunks = output.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
    for (const chunk of chunks) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
      const filePath = match?.[2] ?? match?.[1];
      if (!filePath) continue;
      const text = chunk.trimEnd();
      result.push({ path: filePath, file: filePath, diff: text, patch: text });
    }
    return result;
  }

  async files(input: { from: string; to: string }): Promise<string[]> {
    const cwd = this.workspace;
    const args = ["diff", "--name-only", input.from, input.to];
    let output = "";
    try {
      output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error: any) {
      output = typeof error?.stdout === "string" ? error.stdout : "";
    }
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // Static convenience wrappers. Accept an optional workspace as the first arg
  // so callers can use either `Snapshot.capture()` or `Snapshot.capture(cwd)`.
  static async capture(workspace?: string | { workspace?: string }): Promise<string | undefined> {
    const ws = typeof workspace === "string" ? workspace : workspace?.workspace;
    return new Snapshot(ws).capture();
  }

  static async restore(
    arg1?: string | { files: Map<string, string | undefined>; workspace?: string },
    arg2?: { files: Map<string, string | undefined> },
  ): Promise<void> {
    if (typeof arg1 === "string") {
      return new Snapshot(arg1).restore(arg2 ?? { files: new Map() });
    }
    const ws = (arg1 as any)?.workspace;
    const files = (arg1 as any)?.files ?? arg2?.files ?? new Map();
    return new Snapshot(ws).restore({ files });
  }

  static async diff(
    arg1?: string | SnapshotDiffInput,
    arg2?: SnapshotDiffInput,
  ): Promise<SnapshotDiff[]> {
    if (typeof arg1 === "string") {
      const input = arg2 ?? { from: "", to: "" };
      return new Snapshot(arg1).diff({
        from: input.from,
        to: input.to,
        paths: input.paths,
      });
    }
    const input = (arg1 as SnapshotDiffInput) ?? { from: "", to: "" };
    return new Snapshot(input.workspace).diff({
      from: input.from,
      to: input.to,
      paths: input.paths,
    });
  }

  static async files(
    arg1?: string | SnapshotFilesInput,
    arg2?: SnapshotFilesInput,
  ): Promise<string[]> {
    if (typeof arg1 === "string") {
      const input = arg2 ?? { from: "", to: "" };
      return new Snapshot(arg1).files({ from: input.from, to: input.to });
    }
    const input = (arg1 as SnapshotFilesInput) ?? { from: "", to: "" };
    return new Snapshot(input.workspace).files({ from: input.from, to: input.to });
  }
}

// Standalone helpers for callers that prefer functions.
export async function captureSnapshot(workspace?: string): Promise<string | undefined> {
  return new Snapshot(workspace).capture();
}

export async function restoreSnapshot(input: {
  files: Map<string, string | undefined>;
  workspace?: string;
}): Promise<void> {
  return new Snapshot(input.workspace).restore({ files: input.files });
}

export async function diffSnapshot(input: SnapshotDiffInput): Promise<SnapshotDiff[]> {
  return new Snapshot(input.workspace).diff({
    from: input.from,
    to: input.to,
    paths: input.paths,
  });
}

export async function filesSnapshot(input: SnapshotFilesInput): Promise<string[]> {
  return new Snapshot(input.workspace).files({ from: input.from, to: input.to });
}

// A process-cwd-bound convenience object.
export const snapshot = {
  capture: () => new Snapshot(process.cwd()).capture(),
  restore: (input: { files: Map<string, string | undefined> }) =>
    new Snapshot(process.cwd()).restore(input),
  diff: (input: { from: string; to: string; paths?: string[] }) =>
    new Snapshot(process.cwd()).diff(input),
  files: (input: { from: string; to: string }) =>
    new Snapshot(process.cwd()).files(input),
};
