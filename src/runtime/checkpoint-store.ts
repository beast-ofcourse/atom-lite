import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { userConfigDir } from "../config/paths.js";

export interface CheckpointOptions {
  maxCheckpointBytes?: number;
  maxCheckpoints?: number;
  enabled?: boolean;
}

export interface CheckpointSkipped {
  path: string;
  reason: string;
  target?: string;
}

export interface CheckpointManifest {
  id: string;
  sessionId: string;
  turn: number;
  sequence: number;
  createdAt: number;
  label?: string;
  files: string[];
  skipped: CheckpointSkipped[];
  bytes: number;
  empty: boolean;
}

export interface CheckpointAvailability {
  available: boolean;
  reason?: string;
}

export interface CheckpointPreview {
  changed: string[];
  restored: string[];
  removed: string[];
}

export interface CheckpointDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 20;

export class CheckpointStore {
  private workspace: string;
  private sessionId: string;
  private maxBytes: number;
  private maxCount: number;
  private enabled: boolean;
  private sequence = 0;
  private gitAvailableCache: boolean | undefined;

  constructor(
    workspace: string,
    sessionId: string,
    options: CheckpointOptions = {},
  ) {
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.maxBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_BYTES;
    this.maxCount = options.maxCheckpoints ?? DEFAULT_MAX_COUNT;
    this.enabled = options.enabled ?? true;
    try {
      const seqs = this.list().map((m) => m.sequence ?? 0);
      this.sequence = seqs.length ? Math.max(...seqs) : 0;
    } catch {
      this.sequence = 0;
    }
  }

  private workspaceHash(): string {
    return createHash("sha256")
      .update(this.workspace)
      .digest("hex")
      .slice(0, 16);
  }

  private storageRoot(): string {
    return join(
      userConfigDir(),
      "checkpoints",
      this.workspaceHash(),
      this.sessionId,
    );
  }

  private checkpointDir(id: string): string {
    return join(this.storageRoot(), id);
  }

  private filesDir(id: string): string {
    return join(this.checkpointDir(id), "files");
  }

  private manifestPath(id: string): string {
    return join(this.checkpointDir(id), "manifest.json");
  }

  private isGitAvailable(): boolean {
    if (this.gitAvailableCache !== undefined) return this.gitAvailableCache;
    try {
      const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.workspace,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString("utf8")
        .trim();
      this.gitAvailableCache = out === "true";
    } catch {
      this.gitAvailableCache = false;
    }
    return this.gitAvailableCache;
  }

  isAvailable(): CheckpointAvailability {
    if (!this.enabled)
      return { available: false, reason: "checkpointing disabled" };
    if (this.isGitAvailable()) return { available: true };
    return {
      available: true,
      reason: "filesystem fallback (not a git worktree)",
    };
  }

  private runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.workspace,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  }

  private listWorkspaceFiles(): string[] {
    if (this.isGitAvailable()) {
      let tracked: string[] = [];
      let untracked: string[] = [];
      try {
        tracked = this.runGit(["ls-files", "-z"]).split("\0").filter(Boolean);
      } catch {
        tracked = [];
      }
      try {
        untracked = this.runGit([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
          .split("\0")
          .filter(Boolean);
      } catch {
        untracked = [];
      }
      return [...new Set([...tracked, ...untracked])].sort();
    }
    return this.walkWorkspaceFiles();
  }

  private loadIgnorePatterns(): string[] {
    const patterns: string[] = [];
    try {
      const raw = readFileSync(join(this.workspace, ".gitignore"), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        patterns.push(trimmed);
      }
    } catch {
      // No .gitignore or unreadable; ignore nothing extra.
    }
    return patterns;
  }

  private isIgnored(rel: string, isDir: boolean): boolean {
    const patterns = this.loadIgnorePatterns();
    for (const raw of patterns) {
      let p = raw;
      let dirOnly = false;
      if (p.endsWith("/")) {
        dirOnly = true;
        p = p.replace(/\/+$/, "");
      }
      if (dirOnly && !isDir) continue;
      const anchored = p.startsWith("/");
      if (anchored) p = p.slice(1);
      const re = new RegExp(
        "^" +
          p
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, ".*")
            .replace(/\*/g, "[^/]*") +
          "$",
      );
      const target = anchored ? rel : (rel.split("/").pop() ?? rel);
      if (re.test(rel) || (!anchored && re.test(target))) return true;
    }
    return false;
  }

  private walkWorkspaceFiles(): string[] {
    const SKIP = new Set([
      ".git",
      "node_modules",
      "dist",
      ".next",
      ".atom-lite",
    ]);
    const out: string[] = [];
    const walk = (dir: string, relPrefix: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        const isDir = st.isDirectory();
        if (this.isIgnored(rel, isDir)) continue;
        if (isDir) {
          walk(full, rel);
        } else if (st.isFile()) {
          out.push(rel);
        }
      }
    };
    walk(this.workspace, "");
    return out.sort();
  }

  private isSymlink(rel: string): boolean {
    try {
      return lstatSync(join(this.workspace, rel)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  private isSubmodule(rel: string): boolean {
    try {
      const full = join(this.workspace, rel);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(join(full, ".git"));
    } catch {
      return false;
    }
  }

  list(): CheckpointManifest[] {
    const root = this.storageRoot();
    if (!existsSync(root)) return [];
    const out: CheckpointManifest[] = [];
    for (const name of readdirSync(root)) {
      const mp = join(root, name, "manifest.json");
      if (!existsSync(mp)) continue;
      try {
        const m = JSON.parse(readFileSync(mp, "utf8")) as CheckpointManifest;
        out.push(m);
      } catch {
        // skip corrupt
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence);
    return out;
  }

  get(id: string): CheckpointManifest | undefined {
    const mp = this.manifestPath(id);
    if (!existsSync(mp)) return undefined;
    try {
      return JSON.parse(readFileSync(mp, "utf8")) as CheckpointManifest;
    } catch {
      return undefined;
    }
  }

  create(turn: number, label?: string): CheckpointManifest {
    const avail = this.isAvailable();
    if (!avail.available)
      throw new Error(avail.reason ?? "checkpoint unavailable");

    // prune by count
    const existing = this.list();
    if (existing.length >= this.maxCount) {
      const toRemove = existing.slice(this.maxCount - 1);
      for (const m of toRemove) {
        rmSync(this.checkpointDir(m.id), { recursive: true, force: true });
      }
    }

    this.sequence += 1;
    const id = `${this.sessionId}-${turn}-${this.sequence}`;
    try {
      mkdirSync(this.storageRoot(), { recursive: true, mode: 0o700 });
      chmodSync(this.storageRoot(), 0o700);
    } catch {
      // best effort
    }
    const dir = this.checkpointDir(id);
    const filesDir = this.filesDir(id);
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }

    const skipped: CheckpointSkipped[] = [];
    const captured: string[] = [];
    let bytes = 0;

    const files = this.listWorkspaceFiles();
    // first pass: compute sizes
    const toCopy: Array<{ rel: string; size: number }> = [];
    for (const rel of files) {
      const full = join(this.workspace, rel);
      if (this.isSymlink(rel)) {
        let target: string | undefined;
        try {
          target = readlinkSync(join(this.workspace, rel));
        } catch {
          target = undefined;
        }
        skipped.push({ path: rel, reason: "symlink", target });
        continue;
      }
      if (this.isSubmodule(rel)) {
        skipped.push({ path: rel, reason: "submodule" });
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        skipped.push({ path: rel, reason: "deleted" });
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: "not a regular file" });
        continue;
      }
      if (bytes + st.size > this.maxBytes) {
        skipped.push({ path: rel, reason: "too_large" });
        continue;
      }
      bytes += st.size;
      toCopy.push({ rel, size: st.size });
    }

    for (const { rel } of toCopy) {
      const src = join(this.workspace, rel);
      const dst = join(filesDir, rel);
      mkdirSync(join(dst, ".."), { recursive: true });
      copyFileSync(src, dst);
      captured.push(rel);
    }

    const manifest: CheckpointManifest = {
      id,
      sessionId: this.sessionId,
      turn,
      sequence: this.sequence,
      createdAt: Date.now(),
      label,
      files: captured,
      skipped,
      bytes,
      empty: captured.length === 0 && skipped.length === 0,
    };
    writeFileSync(this.manifestPath(id), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    // ensure storage root perms
    try {
      mkdirSync(this.storageRoot(), { recursive: true, mode: 0o700 });
    } catch {
      // ignore
    }
    return manifest;
  }

  isAtCheckpoint(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    const current = this.listWorkspaceFiles();
    const snapSet = new Set(m.files);
    if (current.length !== m.files.length) {
      // could still be equal set; check set equality
      if (current.length !== snapSet.size) return false;
    }
    if (current.length !== snapSet.size) return false;
    for (const rel of current) {
      if (!snapSet.has(rel)) return false;
    }
    // compare contents
    for (const rel of m.files) {
      const a = join(this.workspace, rel);
      const b = join(this.filesDir(id), rel);
      if (!existsSync(a) || !existsSync(b)) return false;
      if (!readFileSync(a).equals(readFileSync(b))) return false;
    }
    // skipped entries (e.g. symlinks) must keep the same shape/target
    for (const sk of m.skipped ?? []) {
      const full = join(this.workspace, sk.path);
      if (!existsSync(full)) continue;
      if (sk.reason === "symlink") {
        if (!lstatSync(full).isSymbolicLink()) return false;
        if (sk.target !== undefined) {
          try {
            if (readlinkSync(full) !== sk.target) return false;
          } catch {
            return false;
          }
        }
      }
    }
    return true;
  }

  previewRestore(id: string, keepUntracked = false): CheckpointPreview {
    const m = this.get(id);
    if (!m) throw new Error("CHECKPOINT_NOT_FOUND");
    const snapSet = new Set(m.files);
    const current = this.listWorkspaceFiles();
    const changed: string[] = [];
    const restored: string[] = [];
    const removed: string[] = [];
    for (const rel of m.files) {
      const cur = join(this.workspace, rel);
      const snap = join(this.filesDir(id), rel);
      if (!existsSync(cur)) {
        restored.push(rel);
      } else if (!readFileSync(cur).equals(readFileSync(snap))) {
        changed.push(rel);
      }
    }
    if (!keepUntracked) {
      for (const rel of current) {
        if (!snapSet.has(rel)) removed.push(rel);
      }
    }
    return { changed, restored, removed };
  }

  restore(id: string, keepUntracked = false): CheckpointPreview {
    const m = this.get(id);
    if (!m) throw new Error("CHECKPOINT_NOT_FOUND");
    const preview = this.previewRestore(id, keepUntracked);
    // write snapshot files
    for (const rel of m.files) {
      const src = join(this.filesDir(id), rel);
      const dst = join(this.workspace, rel);
      if (!existsSync(src)) continue;
      mkdirSync(join(dst, ".."), { recursive: true });
      copyFileSync(src, dst);
    }
    // remove
    if (!keepUntracked) {
      const snapSet = new Set(m.files);
      const current = this.listWorkspaceFiles();
      for (const rel of current) {
        if (snapSet.has(rel)) continue;
        const full = join(this.workspace, rel);
        if (existsSync(full)) {
          rmSync(full, { force: true });
        }
      }
    }
    return preview;
  }

  diff(id?: string): CheckpointDiffEntry[] {
    let manifest: CheckpointManifest | undefined;
    if (id) manifest = this.get(id);
    else {
      const list = this.list();
      if (list.length) manifest = list[0];
    }
    if (manifest) {
      const snapSet = new Set(manifest.files);
      const current = this.listWorkspaceFiles();
      const out: CheckpointDiffEntry[] = [];
      for (const rel of manifest.files) {
        const cur = join(this.workspace, rel);
        if (!existsSync(cur)) {
          out.push({ path: rel, status: "deleted" });
        } else if (
          !readFileSync(cur).equals(
            readFileSync(join(this.filesDir(manifest.id), rel)),
          )
        ) {
          out.push({ path: rel, status: "modified" });
        }
      }
      for (const rel of current) {
        if (!snapSet.has(rel)) out.push({ path: rel, status: "added" });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    // fallback to git HEAD
    try {
      const out: CheckpointDiffEntry[] = [];
      const nameStatus = this.runGit(["diff", "--name-status", "HEAD"]);
      for (const line of nameStatus.split("\n").filter(Boolean)) {
        const [code, ...rest] = line.split("\t");
        const p = rest.join("\t");
        if (code.startsWith("A")) out.push({ path: p, status: "added" });
        else if (code.startsWith("D")) out.push({ path: p, status: "deleted" });
        else out.push({ path: p, status: "modified" });
      }
      const untracked = this.runGit([
        "ls-files",
        "--others",
        "--exclude-standard",
      ])
        .split("\n")
        .filter(Boolean);
      for (const p of untracked) out.push({ path: p, status: "added" });
      return out;
    } catch {
      return [];
    }
  }

  discard(id: string): void {
    rmSync(this.checkpointDir(id), { recursive: true, force: true });
  }

  snapshotFileContent(id: string, rel: string): Buffer | null {
    const m = this.get(id);
    if (!m || !m.files.includes(rel)) return null;
    const full = join(this.filesDir(id), rel);
    if (!existsSync(full)) return null;
    return readFileSync(full);
  }

  prune(): void {
    const list = this.list();
    if (list.length <= this.maxCount) return;
    const toRemove = list.slice(this.maxCount);
    for (const m of toRemove) {
      rmSync(this.checkpointDir(m.id), { recursive: true, force: true });
    }
  }
}
