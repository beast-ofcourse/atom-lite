import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
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
  Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, sep, dirname } from "node:path";
import { userConfigDir } from "../config/paths.js";

export interface CheckpointOptions {
  maxCheckpointBytes?: number;
  maxCheckpoints?: number;
  /**
   * Hard cap on enumerated files per capture. Restoring hundreds of
   * thousands of files is not a realistic undo anyway; without this cap a
   * capture on a home-directory workspace walks for minutes and blocks
   * the turn (observed: 468,926 files, 3m22s, plus a second full pass in
   * the sync fallback).
   */
  maxCheckpointFiles?: number;
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
  /**
   * True when the capture stopped early (byte cap or file-count cap).
   * A truncated checkpoint is partial: it may not cover the whole
   * workspace, and `isAtCheckpoint` will generally report false.
   */
  truncated?: boolean;
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
const DEFAULT_MAX_FILES = 50_000;
/** Hard cap on worker-thread checkpoint creation before synced fallback. */
const CHECKPOINT_WORKER_TIMEOUT_MS = 120_000;

interface IgnoreMatcher {
  re: RegExp;
  dirOnly: boolean;
  baseNameOnly: boolean;
  /** Test a candidate path with the original anchored/basename semantics. */
  test: (rel: string) => boolean;
}

export class CheckpointStore {
  private workspace: string;
  private sessionId: string;
  private maxBytes: number;
  private maxCount: number;
  private maxFiles: number;
  private enabled: boolean;
  private sequence = 0;
  private orphansPruned = false;
  private gitAvailableCache: boolean | undefined;
  private workspaceHashCache: string | undefined;
  private storageRootCache: string | undefined;
  private storageRootEnvKey: string | undefined;

  constructor(
    workspace: string,
    sessionId: string,
    options: CheckpointOptions = {},
  ) {
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.maxBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_BYTES;
    this.maxCount = options.maxCheckpoints ?? DEFAULT_MAX_COUNT;
    this.maxFiles = options.maxCheckpointFiles ?? DEFAULT_MAX_FILES;
    this.enabled = options.enabled ?? true;
    try {
      const seqs = this.list().map((m) => m.sequence ?? 0);
      this.sequence = seqs.length ? Math.max(...seqs) : 0;
    } catch {
      this.sequence = 0;
    }
  }

  private workspaceHash(): string {
    if (this.workspaceHashCache === undefined) {
      this.workspaceHashCache = createHash("sha256")
        .update(this.workspace)
        .digest("hex")
        .slice(0, 16);
    }
    return this.workspaceHashCache;
  }

  private storageRoot(): string {
    // userConfigDir() is env-dependent; keep the memo honest by invalidating
    // when XDG_CONFIG_HOME changes (or comparing against the no-env default).
    const envKey = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    if (
      this.storageRootCache === undefined ||
      this.storageRootEnvKey !== envKey
    ) {
      this.storageRootCache = join(
        userConfigDir(),
        "checkpoints",
        this.workspaceHash(),
        this.sessionId,
      );
      this.storageRootEnvKey = envKey;
    }
    return this.storageRootCache;
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
    this.walkTruncated = false;
    // Atom-lite's own storage (checkpoints, sessions) must never appear in
    // a capture; see walkWorkspaceFiles for why.
    const selfStorage = userConfigDir() + sep;
    const notSelf = (rel: string) =>
      !join(this.workspace, rel).startsWith(selfStorage);
    const cap = (files: string[]): string[] => {
      if (files.length > this.maxFiles) {
        this.walkTruncated = true;
        return files.slice(0, this.maxFiles);
      }
      return files;
    };
    if (this.isGitAvailable()) {
      try {
        const out = this.runGit([
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
          .split("\0")
          .filter(Boolean);
        return cap([...new Set(out)].filter(notSelf).sort());
      } catch {
        // fall back to separate calls if combined flags unsupported
      }
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
      return cap(
        [...new Set([...tracked, ...untracked])].filter(notSelf).sort(),
      );
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

  /**
   * One compiled matcher per walk. Matching semantics are identical to the
   * pre-compile version; this just avoids re-reading .gitignore and rebuilding
   * RegExp objects for every single file examined during a traversal.
   */
  private matchesIgnore(
    matchers: IgnoreMatcher[],
    rel: string,
    isDir: boolean,
  ): boolean {
    for (const m of matchers) {
      if (m.dirOnly && !isDir) continue;
      if (m.test(rel)) return true;
    }
    return false;
  }

  private compileIgnorePatterns(patterns: string[]): IgnoreMatcher[] {
    return patterns.map((raw) => {
      let p = raw;
      let dirOnly = false;
      if (p.endsWith("/")) {
        dirOnly = true;
        p = p.replace(/\/+$/, "");
      }
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
      const base = anchored
        ? (rel: string) => rel
        : (rel: string) => {
            const slash = rel.lastIndexOf("/");
            return slash === -1 ? rel : rel.slice(slash + 1);
          };
      const baseNameOnly = !anchored;
      return {
        re,
        dirOnly,
        baseNameOnly,
        test: (rel: string) =>
          re.test(rel) || (baseNameOnly && re.test(base(rel))),
      };
    });
  }

  private walkWorkspaceFiles(): string[] {
    const SKIP = new Set([
      ".git",
      "node_modules",
      "dist",
      ".next",
      ".atom-lite",
    ]);
    // Atom-lite's own storage (checkpoints, sessions, logs) lives under
    // userConfigDir(). When the workspace is the home directory that tree is
    // inside the workspace and the capture would walk and re-copy its own
    // previous checkpoints — a self-amplifying loop observed in practice
    // (468,926-file captures on /home/bhavin). Exclude it by absolute path;
    // for any other workspace the prefix never matches.
    const selfStorage = userConfigDir() + sep;
    const matchers = this.compileIgnorePatterns(this.loadIgnorePatterns());
    const out: string[] = [];
    let truncated = false;
    // Classify entries exactly like the previous statSync-based version (which
    // follows symlinks) but avoid one stat syscall per entry: readdir with
    // Dirent already knows directory/regular-file types, so statSync is only
    // needed for symlinks and for the DT_UNKNOWN / special-file cases that
    // Dirent leaves ambiguous; identical classification semantics.
    const kindOf = (full: string, ent: Dirent): "dir" | "file" | "other" => {
      if (!ent.isSymbolicLink() && ent.isDirectory()) return "dir";
      if (!ent.isSymbolicLink() && ent.isFile()) return "file";
      // symlink, DT_UNKNOWN, fifo/socket/device: fall back to the same
      // statSync-following classification as before
      let st;
      try {
        st = statSync(full);
      } catch {
        return "other"; // old code hit this catch and skipped the entry too
      }
      if (st.isDirectory()) return "dir";
      if (st.isFile()) return "file";
      return "other";
    };
    const walk = (dir: string, relPrefix: string) => {
      if (out.length >= this.maxFiles) {
        truncated = true;
        return;
      }
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const name of entries) {
        if (out.length >= this.maxFiles) {
          truncated = true;
          return;
        }
        if (SKIP.has(name.name)) continue;
        const full = join(dir, name.name);
        // Never descend into Atom-lite's own storage; see selfStorage above.
        if (full === userConfigDir() || full.startsWith(selfStorage)) continue;
        const rel = relPrefix ? `${relPrefix}/${name.name}` : name.name;
        const kind = kindOf(full, name);
        const isDir = kind === "dir";
        if (this.matchesIgnore(matchers, rel, isDir)) continue;
        if (kind === "dir") {
          walk(full, rel);
        } else if (kind === "file") {
          out.push(rel);
        }
      }
    };
    walk(this.workspace, "");
    this.walkTruncated = truncated;
    return out.sort();
  }

  /** Whether the last walkWorkspaceFiles() hit the file-count cap. */
  private walkTruncated = false;

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

    // A terminated worker (timeout) or crashed capture leaves a checkpoint
    // directory without a manifest. Clean those up once per store instance
    // so they cannot accumulate (observed: a ~500k-file orphan from one
    // abandoned capture) and so the sequence numbering stays honest.
    if (!this.orphansPruned) {
      this.orphansPruned = true;
      const root = this.storageRoot();
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          if (!existsSync(join(root, name, "manifest.json"))) {
            try {
              rmSync(join(root, name), { recursive: true, force: true });
            } catch {
              // best effort
            }
          }
        }
      }
    }

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
    // first pass: compute sizes. Once the byte cap is reached, every
    // remaining file is guaranteed to overflow it — stop instead of
    // lstat-ing the rest of a potentially huge tree (on a home-directory
    // workspace that was minutes of wasted syscalls after the cap).
    const toCopy: Array<{ rel: string; size: number }> = [];
    let capReached = this.walkTruncated;
    for (const rel of files) {
      if (capReached) {
        skipped.push({ path: rel, reason: "capture cap reached" });
        continue;
      }
      const full = join(this.workspace, rel);
      // One lstat answers symlink/dir/type/size for this file. For non-symlinks
      // lstat == stat for every field the old code used, so the classification
      // below is identical to the isSymlink/isSubmodule/statSync sequence.
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        skipped.push({ path: rel, reason: "deleted" });
        continue;
      }
      if (lst.isSymbolicLink()) {
        let target: string | undefined;
        try {
          target = readlinkSync(full);
        } catch {
          target = undefined;
        }
        skipped.push({ path: rel, reason: "symlink", target });
        continue;
      }
      if (lst.isDirectory() && existsSync(join(full, ".git"))) {
        skipped.push({ path: rel, reason: "submodule" });
        continue;
      }
      if (!lst.isFile()) {
        skipped.push({ path: rel, reason: "not a regular file" });
        continue;
      }
      if (bytes + lst.size > this.maxBytes) {
        skipped.push({ path: rel, reason: "too_large" });
        if (bytes >= this.maxBytes) capReached = true;
        continue;
      }
      bytes += lst.size;
      toCopy.push({ rel, size: lst.size });
    }

    const copiedDirs = new Set<string>(); // mkdirSync on parents only once per dir
    for (const { rel } of toCopy) {
      const src = join(this.workspace, rel);
      const dst = join(filesDir, rel);
      const dir = dirname(dst);
      if (!copiedDirs.has(dir)) {
        copiedDirs.add(dir);
        mkdirSync(dir, { recursive: true });
      }
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
      truncated: this.walkTruncated || capReached,
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

  /**
   * Create a checkpoint off the main thread so the TUI event loop stays
   * responsive. Falls back to the synchronous path only when the worker
   * cannot start; a timed-out or long-running-then-failed worker
   * propagates the error instead of redoing the capture on the main
   * thread.
   */
  async createAsync(turn: number, label?: string): Promise<CheckpointManifest> {
    let timedOut = false;
    const startedAt = Date.now();
    try {
      return await new Promise<CheckpointManifest>((resolve, reject) => {
        let worker: Worker | undefined;
        // A stalled worker must not hang the turn forever: time out and
        // terminate. The error is surfaced as-is (checkpoint_failed on the
        // turn); it must NOT trigger the synchronous fallback below — that
        // would redo the whole multi-minute capture from scratch on the
        // main thread (observed: worker 120s + sync redo ≈ 5 more minutes
        // blocking a bash approval prompt).
        const timeout = setTimeout(() => {
          timedOut = true;
          try {
            worker?.terminate();
          } catch {
            // ignore
          }
          reject(new Error("checkpoint worker timed out"));
        }, CHECKPOINT_WORKER_TIMEOUT_MS);
        timeout.unref();
        worker = new Worker(
          new URL("./checkpoint-worker.js", import.meta.url),
          {
            workerData: {
              workspace: this.workspace,
              sessionId: this.sessionId,
              options: {
                maxCheckpointBytes: this.maxBytes,
                maxCheckpoints: this.maxCount,
                maxCheckpointFiles: this.maxFiles,
                enabled: this.enabled,
              },
              turn,
              label,
            },
          },
        );
        worker.on(
          "message",
          (msg: {
            ok: boolean;
            manifest?: CheckpointManifest;
            error?: string;
          }) => {
            if (msg.ok && msg.manifest) resolve(msg.manifest);
            else reject(new Error(msg.error ?? "checkpoint worker failed"));
          },
        );
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`checkpoint worker exited ${code}`));
        });
      });
    } catch (err) {
      // Fall back to synchronous creation only when the worker could not
      // run at all (spawn failure, immediate crash) — a fast path by
      // definition. A worker that ran for real time and then failed, or
      // timed out, must propagate: re-running the capture synchronously
      // would redo the whole multi-minute walk on the main thread.
      const ranForReal = Date.now() - startedAt > 3_000;
      if (timedOut || ranForReal) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return this.create(turn, label);
    }
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
    const restoredDirs = new Set<string>(); // mkdirSync on parents only once per dir
    for (const rel of m.files) {
      const src = join(this.filesDir(id), rel);
      const dst = join(this.workspace, rel);
      if (!existsSync(src)) continue;
      const dir = dirname(dst);
      if (!restoredDirs.has(dir)) {
        restoredDirs.add(dir);
        mkdirSync(dir, { recursive: true });
      }
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
