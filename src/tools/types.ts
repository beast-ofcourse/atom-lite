import type { ToolDefinition, ToolCall } from "../types.js";
export type { ToolDefinition, ToolCall };

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Pre-computed line diff for write/edit, so the UI never re-reads files. */
  diff?: string[];
}

export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  maxBashTimeMs?: number;
  maxToolOutputBytes?: number;
  approvals?: import("../runtime/approvals.js").ApprovalContext;
  /** Live output from a running command, forwarded to the UI. */
  onToolOutput?: (
    call: ToolCall,
    stream: "stdout" | "stderr",
    text: string,
  ) => void;
}

export interface ToolRegistry {
  definitions(): ToolDefinition[];
  get(name: string): Tool | undefined;
}
