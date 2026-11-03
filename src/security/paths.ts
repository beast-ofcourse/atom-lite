import { resolve, relative, isAbsolute } from "node:path";

export function isWithinWorkspace(workspace: string, target: string): boolean {
  const rel = relative(resolve(workspace), resolve(workspace, target));
  return !rel.startsWith("..") && !isAbsolute(rel);
}