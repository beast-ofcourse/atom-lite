import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadProjectInstructions(
  workspace: string,
  maxBytes: number,
  userInstructionsPath?: string,
): string[] {
  const out: string[] = [];
  if (userInstructionsPath && existsSync(userInstructionsPath)) {
    out.push(readFileSync(userInstructionsPath, "utf8").slice(0, maxBytes));
  }
  const projectPath = join(workspace, "AGENTS.md");
  if (existsSync(projectPath)) {
    out.push(readFileSync(projectPath, "utf8").slice(0, maxBytes));
  }
  return out;
}