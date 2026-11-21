/** Tools disabled in plan mode. The todo ledger only changes session state,
 * not the workspace, so it stays available in plan mode. */
export const PLAN_BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);

/** Plan mode: the read-only built-ins that stay available. */
export const PLAN_READONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "task",
  "todo",
  "question",
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_symbols",
]);

export function isToolAllowed(
  mode: "plan" | "yolo",
  toolName: string,
): boolean {
  if (mode === "yolo") return true;
  return !PLAN_BLOCKED_TOOLS.has(toolName);
}

/**
 * Plan-mode gate for every tool, including MCP and extension tools the
 * hardcoded built-in set cannot know about: a tool runs in plan mode only if
 * it is a known read-only built-in or declares `readOnlyHint`.
 */
export function isPlanToolAllowed(
  toolName: string,
  readOnlyHint: boolean | undefined,
): boolean {
  if (readOnlyHint === true) return true;
  return PLAN_READONLY_TOOLS.has(toolName);
}

/** Tool result shown to the model when a mutating tool is blocked in plan mode. */
export function planModeBlockMessage(toolName: string): string {
  return `Plan mode is active. The "${toolName}" tool is disabled because it can change the workspace. Only read-only tools are available in plan mode. Press Tab to switch to yolo mode, then retry.`;
}
