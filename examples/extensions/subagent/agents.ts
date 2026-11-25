import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text: string): {
  frontmatter: AgentFrontmatter;
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (lines[start]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized };
  }
  const end = lines.findIndex((line, i) => i > start && line.trim() === "---");
  if (end === -1) return { frontmatter: {}, body: normalized };

  const frontmatter: AgentFrontmatter = {};
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (
      key !== "name" &&
      key !== "description" &&
      key !== "tools" &&
      key !== "model"
    ) {
      continue;
    }
    const value = unquote(match[2].replace(/\s+#.*$/, ""));
    if (key === "tools") {
      frontmatter.tools = value.startsWith("[")
        ? value
            .slice(1, value.length - 1)
            .split(",")
            .map((tool) => unquote(tool))
            .filter(Boolean)
        : value
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean);
    } else {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const agents: AgentConfig[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    try {
      if (!statSync(filePath).isFile()) continue;
      const { frontmatter, body } = parseFrontmatter(
        readFileSync(filePath, "utf8"),
      );
      if (
        typeof frontmatter.name !== "string" ||
        typeof frontmatter.description !== "string"
      ) {
        continue;
      }
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : undefined,
        model:
          typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      continue;
    }
  }
  return agents;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    for (const name of [".atom-lite", ".pi"]) {
      const candidate = join(current, name, "agents");
      if (isDirectory(candidate)) return candidate;
    }
    const parent = join(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

export function userAgentsDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, "agents")
    : join(homedir(), ".pi", "agent", "agents");
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userAgentsDir(), "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const byName = new Map<string, AgentConfig>();
  if (scope !== "project") {
    for (const agent of userAgents) byName.set(agent.name, agent);
  }
  if (scope !== "user") {
    for (const agent of projectAgents) byName.set(agent.name, agent);
  }
  return { agents: [...byName.values()], projectAgentsDir };
}
