import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function loadProjectInstructions(workspace: string, maxBytes: number): string[] {
  const out: string[] = [];
  // User-level instructions (optional, configured path defaults to ~/.config/atom-lite/AGENTS.md)
  const userPath = join(homedir(), ".config", "atom-lite", "AGENTS.md");
  if (existsSync(userPath)) {
    out.push(readFileSync(userPath, "utf8").slice(0, maxBytes));
  }
  const projectPath = join(workspace, "AGENTS.md");
  if (existsSync(projectPath)) {
    out.push(readFileSync(projectPath, "utf8").slice(0, maxBytes));
  }
  return out;
}