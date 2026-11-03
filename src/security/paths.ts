import { resolve, relative, isAbsolute, dirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";

export function isWithinWorkspace(workspace: string, target: string): boolean {
  const ws = resolve(workspace);
  const wsReal = existsSync(ws) ? safeRealpath(ws) : ws;
  const resolvedTarget = resolve(ws, target);

  // Resolve symlinks for the target or, if it does not exist yet, for the
  // nearest existing ancestor, so symlinked parent directories are caught.
  let realTarget = resolvedTarget;
  let cursor = resolvedTarget;
  while (!existsSync(cursor) && cursor !== ws && cursor !== dirname(cursor)) {
    cursor = dirname(cursor);
  }
  if (existsSync(cursor)) {
    try {
      const realCursor = realpathSync(cursor);
      const suffix = resolvedTarget.slice(cursor.length);
      realTarget = realCursor + suffix;
    } catch {
      // fall back to lexical
    }
  }

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
