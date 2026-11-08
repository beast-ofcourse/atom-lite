import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type AgentPermissionDecision = "allow" | "ask" | "deny";

/**
 * Permissions are keyed by tool and then by invocation pattern. A flat
 * frontmatter decision such as `edit: allow` is normalized to `{ "*": "allow" }`
 * so every tool entry shares one shape.
 */
export interface AgentPermissionPolicy {
  [tool: string]: Record<string, AgentPermissionDecision> | undefined;
}

export type AgentSource = "bundled" | "global" | "project" | "opencode";

export interface AgentPersona {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  temperature?: number;
  permissions: AgentPermissionPolicy;
  body: string;
  source: AgentSource;
  path: string;
}

export interface AgentRegistry {
  list(): AgentPersona[];
  get(name: string): AgentPersona | undefined;
  primary(): AgentPersona[];
}

export interface AgentRegistryDirs {
  bundled: string;
  global: string;
  project: string;
  opencode: string;
}

export interface AgentRegistryOptions {
  /** Override discovery directories. Useful for embedding and tests. */
  dirs?: Partial<AgentRegistryDirs>;
}

const FRONTMATTER_DELIMITER = "---";
const DECISIONS = new Set<AgentPermissionDecision>(["allow", "ask", "deny"]);

function bundledDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

export function defaultAgentDirs(workspace: string): AgentRegistryDirs {
  return {
    bundled: bundledDir(),
    global: join(homedir(), ".config", "atom-lite", "agents"),
    project: join(workspace, ".atom-lite", "agents"),
    opencode: join(workspace, ".opencode", "agents"),
  };
}

function indentation(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function parseScalar(value: string): unknown {
  const trimmed = stripInlineComment(value.trim());
  const unquoted = unquote(trimmed);
  if (unquoted !== trimmed) return unquoted;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseDecision(value: string): AgentPermissionDecision | undefined {
  const decision = unquote(value).toLowerCase();
  return DECISIONS.has(decision as AgentPermissionDecision)
    ? (decision as AgentPermissionDecision)
    : undefined;
}

function parsePermissionBlock(lines: string[]): AgentPermissionPolicy {
  const policy: AgentPermissionPolicy = {};
  const entries = lines.filter(
    (line) => line.trim() !== "" && !line.trim().startsWith("#"),
  );
  if (entries.length === 0) return policy;

  const baseIndent = Math.min(...entries.map(indentation));
  let i = 0;
  while (i < entries.length) {
    const line = entries[i];
    if (indentation(line) !== baseIndent) {
      i++;
      continue;
    }
    const match = line.trim().match(/^(.+?):(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const tool = unquote(match[1]);
    const rest = stripInlineComment(match[2].trim());
    if (rest !== "") {
      const decision = parseDecision(rest);
      if (decision) policy[tool] = { "*": decision };
      i++;
      continue;
    }

    // Nested mapping: tool -> invocation pattern -> decision.
    const nested: string[] = [];
    i++;
    while (i < entries.length && indentation(entries[i]) > baseIndent) {
      nested.push(entries[i]);
      i++;
    }
    const rules: Record<string, AgentPermissionDecision> = {};
    for (const nestedLine of nested) {
      // Split on the final colon so glob patterns may contain colons.
      const rule = stripInlineComment(nestedLine.trim()).match(
        /^(.*):\s*(allow|ask|deny)\s*$/i,
      );
      if (!rule) continue;
      rules[unquote(rule[1])] = parseDecision(rule[2])!;
    }
    if (Object.keys(rules).length > 0) policy[tool] = rules;
  }
  return policy;
}

function splitFrontmatter(text: string): {
  frontmatterLines: string[];
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { frontmatterLines: [], body: normalized };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (end === -1) return { frontmatterLines: [], body: normalized };
  return {
    frontmatterLines: lines.slice(1, end),
    body: lines.slice(end + 1).join("\n"),
  };
}

function parseFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const { frontmatterLines, body } = splitFrontmatter(text);
  const frontmatter: Record<string, unknown> = {};
  let i = 0;
  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || indentation(line) > 0) {
      i++;
      continue;
    }
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = unquote(match[1]);
    const rest = stripInlineComment(match[2].trim());
    if (rest !== "") {
      frontmatter[key] = parseScalar(rest);
      i++;
      continue;
    }

    const blockLines: string[] = [];
    i++;
    while (
      i < frontmatterLines.length &&
      (frontmatterLines[i].trim() === "" ||
        indentation(frontmatterLines[i]) > 0)
    ) {
      blockLines.push(frontmatterLines[i]);
      i++;
    }
    if (key === "permission") {
      frontmatter.permission = parsePermissionBlock(blockLines);
    }
  }
  return { frontmatter, body };
}

function personaFromText(
  text: string,
  fallbackName: string,
  source: AgentSource,
  path: string,
): AgentPersona | undefined {
  const { frontmatter, body } = parseFrontmatter(text);
  const mode = frontmatter.mode;
  if (mode !== "primary" && mode !== "subagent") return undefined;

  const rawName = frontmatter.name;
  const name =
    typeof rawName === "string" && rawName.trim() !== ""
      ? rawName.trim()
      : fallbackName;

  const rawTemperature = frontmatter.temperature;
  const temperature =
    typeof rawTemperature === "number" && Number.isFinite(rawTemperature)
      ? rawTemperature
      : undefined;

  return {
    name,
    description:
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : "",
    mode,
    temperature,
    permissions:
      typeof frontmatter.permission === "object" &&
      frontmatter.permission !== null
        ? (frontmatter.permission as AgentPermissionPolicy)
        : {},
    body: body.trim(),
    source,
    path,
  };
}

function scanDir(dir: string, source: AgentSource): AgentPersona[] {
  const out: AgentPersona[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const file = join(dir, entry);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const persona = personaFromText(
      text,
      entry.replace(/\.md$/i, ""),
      source,
      file,
    );
    if (persona) out.push(persona);
  }
  return out;
}

export class DefaultAgentRegistry implements AgentRegistry {
  private agents: AgentPersona[];

  constructor(workspace: string, options: AgentRegistryOptions = {}) {
    const dirs = { ...defaultAgentDirs(workspace), ...options.dirs };
    // Later layers override earlier ones. Project-local sources sit above
    // global, and the canonical `.atom-lite` directory beats the migration
    // `.opencode` directory.
    const layers: Array<[string, AgentSource]> = [
      [dirs.bundled, "bundled"],
      [dirs.global, "global"],
      [dirs.opencode, "opencode"],
      [dirs.project, "project"],
    ];
    const map = new Map<string, AgentPersona>();
    for (const [dir, source] of layers) {
      for (const persona of scanDir(dir, source)) {
        map.set(persona.name, persona);
      }
    }
    this.agents = [...map.values()];
  }

  list(): AgentPersona[] {
    return this.agents;
  }

  get(name: string): AgentPersona | undefined {
    return this.agents.find((agent) => agent.name === name);
  }

  primary(): AgentPersona[] {
    return this.agents.filter((agent) => agent.mode === "primary");
  }
}
