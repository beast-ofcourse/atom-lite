import type {
  AgentPermissionDecision,
  AgentPermissionPolicy,
} from "./registry.js";

export interface PermissionMatch {
  decision: AgentPermissionDecision;
  pattern: string;
}

/** Match one opencode-style glob (`*` and `?` wildcards). */
export function matchPermissionPattern(
  pattern: string,
  value: string,
): boolean {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(value);
}

function specificity(pattern: string, value: string): number {
  if (pattern === value) return Number.POSITIVE_INFINITY;
  return pattern.replace(/[*?]/g, "").length;
}

/**
 * Resolve the most specific matching rule for a tool invocation. An exact
 * pattern beats any glob; otherwise the glob with the most literal characters
 * wins, so `"git log*": allow` overrides `"*": ask` regardless of declaration
 * order.
 */
export function resolveToolPermission(
  policy: AgentPermissionPolicy | undefined,
  tool: string,
  invocation: string,
): PermissionMatch | undefined {
  const rules = policy?.[tool];
  if (!rules) return undefined;
  let best: PermissionMatch | undefined;
  let bestScore = -1;
  for (const [pattern, decision] of Object.entries(rules)) {
    if (!matchPermissionPattern(pattern, invocation)) continue;
    const score = specificity(pattern, invocation);
    if (score >= bestScore) {
      best = { decision, pattern };
      bestScore = score;
    }
  }
  return best;
}

/** The value a persona permission rule is matched against for a tool call. */
export function permissionInvocation(
  tool: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "";
  const candidates =
    tool === "bash"
      ? [args.command]
      : ["webfetch", "websearch"].includes(tool)
        ? [args.url, args.query, args.prompt]
        : [args.path, args.file_path, args.pattern, args.glob, args.cwd];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}
