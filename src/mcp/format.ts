import type { McpServerStatus } from "./types.js";

export function formatMcpStatus(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) {
    return "MCP servers: none configured";
  }
  const lines = ["MCP servers:"];
  for (const status of statuses) {
    const state = status.enabled ? status.state : "disabled";
    let suffix = "";
    if (status.state === "failed" && status.lastError) {
      suffix = `: ${status.lastError}`;
    } else if (status.state === "ready") {
      suffix = ` (${status.toolCount} tool${status.toolCount === 1 ? "" : "s"})`;
      if (status.requiresApproval) suffix += " [requires approval]";
    } else if (status.state === "disabled") {
      suffix = " (disabled)";
    }
    lines.push(`  ${status.name}: ${state}${suffix}`);
  }
  return lines.join("\n");
}

export function formatMcpDoctor(statuses: McpServerStatus[]): string[] {
  const lines: string[] = ["  mcp:"];
  if (statuses.length === 0) {
    lines.push("    none configured");
    return lines;
  }
  for (const status of statuses) {
    const tools =
      status.state === "ready"
        ? ` ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`
        : "";
    const error = status.lastError ? ` lastError=${status.lastError}` : "";
    lines.push(`    ${status.name}: ${status.state}${tools}${error}`);
  }
  return lines;
}
