import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadProjectInstructions(
  workspace: string,
  maxBytes: number,
  userInstructionsPath?: string,
): string[] {
  const out: string[] = [];
  if (userInstructionsPath && existsSync(userInstructionsPath)) {
    const buf = readFileSync(userInstructionsPath);
    out.push(buf.subarray(0, maxBytes).toString("utf8"));
  }
  const projectPath = join(workspace, "AGENTS.md");
  if (existsSync(projectPath)) {
    const buf = readFileSync(projectPath);
    out.push(buf.subarray(0, maxBytes).toString("utf8"));
  }
  return out;
}
