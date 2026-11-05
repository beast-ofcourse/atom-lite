import type { ToolDefinition, ToolCall } from "../types.js";
export type { ToolDefinition, ToolCall };

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Pre-computed line diff for write/edit, so the UI never re-reads files. */
  diff?: string[];
  /** Preserved extension result details for renderers and session state. */
  details?: unknown;
  structuredContent?: unknown;
  usage?: unknown;
}

export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  annotations?: Record<string, unknown>;
  exposure?: string;
}

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  maxBashTimeMs?: number;
  maxToolOutputBytes?: number;
  approvals?: import("../runtime/approvals.js").ApprovalContext;
  /** Current agent mode; plan blocks write/edit/bash. */
  mode?: "plan" | "yolo";
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
