import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];

/** Cheap change detector for a set of files (mtime + size). */
export function statSignature(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/** Find instruction files beside a read target, walking up to the workspace root exclusive. */
export function discoverInstructionPaths(
  workspace: string,
  target: string,
): string[] {
  try {
    if (!existsSync(target) || !isAbsolute(target)) return [];
    const root = realpathSync(workspace);
    const resolved = realpathSync(target);
    let cursor = statSync(resolved).isDirectory()
      ? resolved
      : dirname(resolved);
    const found: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      const rel = relative(root, cursor);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) break;
      for (const name of INSTRUCTION_NAMES) {
        const candidate = join(cursor, name);
        if (!existsSync(candidate)) continue;
        let key = candidate;
        try {
          key = realpathSync(candidate);
        } catch {
          // Keep the lexical path when the file cannot be resolved.
        }
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(candidate);
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return found;
  } catch {
    return [];
  }
}

export function loadProjectInstructions(
  workspace: string,
  maxBytes: number,
  userInstructionsPath?: string,
  extraPaths: string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushFile = (p: string): void => {
    if (!existsSync(p)) return;
    // Dedup by resolved path so the same file isn't loaded twice
    // (e.g. when CLAUDE.md and AGENTS.md resolve to the same path).
    let key = p;
    try {
      key = realpathSync(p);
    } catch {
      key = p;
    }
    if (seen.has(key)) return;
    seen.add(key);
    const buf = readFileSync(p);
    out.push(buf.subarray(0, maxBytes).toString("utf8"));
  };
  if (userInstructionsPath) pushFile(userInstructionsPath);
  for (const name of INSTRUCTION_NAMES) pushFile(join(workspace, name));
  for (const path of extraPaths) pushFile(path);
  return out;
}
