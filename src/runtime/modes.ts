/** Tools disabled in plan mode. The todo ledger only changes session state,
 * not the workspace, so it stays available in plan mode. */
export const PLAN_BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);

export function isToolAllowed(
  mode: "plan" | "yolo",
  toolName: string,
): boolean {
  if (mode === "yolo") return true;
  return !PLAN_BLOCKED_TOOLS.has(toolName);
}
