import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SnapshotDiff {
  path: string;
  file: string;
  diff: string;
  patch: string;
}

interface DiffInput {
  from: string;
  to: string;
  paths?: string[];
  workspace?: string;
}

interface FilesInput {
  from: string;
  to: string;
  workspace?: string;
}

interface RestoreInput {
  files: Map<string, string | undefined>;
  workspace?: string;
}

function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args);
  } catch (error: unknown) {
    const stdout = (error as { stdout?: unknown })?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
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
      runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        // tmp file may not exist yet
      }
      runGit(cwd, ["read-tree", "--empty"], env);
      runGit(cwd, ["add", "-A"], env);
      const tree = runGit(cwd, ["write-tree"], env).trim();
      return tree || undefined;
    } catch {
      return undefined;
    } finally {
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        // tmp file may already be gone
      }
    }
  }

  async restore(input: RestoreInput): Promise<void> {
    const cwd = this.workspace;
    const root = path.resolve(cwd);
    for (const [relativePath, treeId] of input.files) {
      const rel = relativePath.replace(/^\.?\//, "");
      const absolute = path.resolve(cwd, rel);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;
      if (!treeId) {
        try {
          rmSync(absolute, { recursive: true, force: true });
        } catch {
          // best effort
        }
        continue;
      }
      try {
        runGit(cwd, ["restore", "--source", treeId, "--worktree", "--", rel]);
      } catch {
        try {
          runGit(cwd, ["checkout", treeId, "--", rel]);
        } catch {
          try {
            rmSync(absolute, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
      }
    }
  }

  async diff(input: DiffInput): Promise<SnapshotDiff[]> {
    const args = ["diff", "--no-color", input.from, input.to];
    if (input.paths && input.paths.length > 0) args.push("--", ...input.paths);
    const output = tryGit(this.workspace, args);
    const diffs: SnapshotDiff[] = [];
    for (const chunk of output.split(/(?=^diff --git )/m)) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
      const filePath = match?.[2] ?? match?.[1];
      if (!filePath) continue;
      const text = chunk.trimEnd();
      diffs.push({ path: filePath, file: filePath, diff: text, patch: text });
    }
    return diffs;
  }

  async files(input: FilesInput): Promise<string[]> {
    return tryGit(this.workspace, ["diff", "--name-only", input.from, input.to])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  static capture(workspace?: string): Promise<string | undefined> {
    return new Snapshot(workspace).capture();
  }

  static restore(input: RestoreInput): Promise<void> {
    return new Snapshot(input.workspace).restore(input);
  }

  static diff(input: DiffInput): Promise<SnapshotDiff[]> {
    return new Snapshot(input.workspace).diff(input);
  }

  static files(input: FilesInput): Promise<string[]> {
    return new Snapshot(input.workspace).files(input);
  }
}
