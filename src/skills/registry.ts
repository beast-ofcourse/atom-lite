import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Skill {
  name: string;
  description: string;
  path: string;
  scope: "global" | "project";
}

export interface SkillRegistry {
  list(): Skill[];
  load(name: string): string | undefined;
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function scanDir(dir: string, scope: "global" | "project"): Skill[] {
  const out: Skill[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const skillDir = join(dir, e);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let text = "";
    try {
      text = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm.name) continue;
    out.push({
      name: fm.name,
      description: fm.description ?? "",
      path: skillFile,
      scope,
    });
  }
  return out;
}

export class DefaultSkillRegistry implements SkillRegistry {
  private skills: Skill[] = [];

  constructor(workspace: string) {
    const globalDir = join(homedir(), ".agents", "skills");
    const projectDir = join(workspace, ".agents", "skills");
    const globalSkills = scanDir(globalDir, "global");
    const projectSkills = scanDir(projectDir, "project");
    // project overrides global on name collision
    const map = new Map<string, Skill>();
    for (const s of globalSkills) map.set(s.name, s);
    for (const s of projectSkills) map.set(s.name, s);
    this.skills = [...map.values()];
  }

  list(): Skill[] {
    return this.skills;
  }

  load(name: string): string | undefined {
    const s = this.skills.find((x) => x.name === name);
    if (!s) return undefined;
    try {
      return readFileSync(s.path, "utf8");
    } catch {
      return undefined;
    }
  }

  indexText(): string {
    if (this.skills.length === 0) return "";
    const lines = this.skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`);
    return `Available skills:\n${lines.join("\n")}\n\nRead a skill's SKILL.md with the read tool when relevant.`;
  }
}