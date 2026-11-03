import { resolve, relative, isAbsolute } from "node:path";
import { realpathSync, existsSync } from "node:fs";

export function isWithinWorkspace(workspace: string, target: string): boolean {
  const ws = resolve(workspace);
  const resolvedTarget = resolve(ws, target);
  // Resolve symlinks when the target exists to catch escape via links.
  let realTarget = resolvedTarget;
  if (existsSync(resolvedTarget)) {
    try {
      realTarget = realpathSync(resolvedTarget);
    } catch {
      // fall back to lexical
    }
  }
  const wsReal = existsSync(ws) ? safeRealpath(ws) : ws;
  const rel = relative(wsReal, realTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}