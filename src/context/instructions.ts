import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";

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

export function loadProjectInstructions(
  workspace: string,
  maxBytes: number,
  userInstructionsPath?: string,
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
  pushFile(join(workspace, "AGENTS.md"));
  pushFile(join(workspace, "CLAUDE.md"));
  return out;
}
