import type { ToolDefinition, ToolCall } from "../types.js";
export type { ToolDefinition, ToolCall };

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
}

export interface ToolRegistry {
  definitions(): ToolDefinition[];
  get(name: string): Tool | undefined;
}