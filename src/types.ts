// Canonical types shared across the runtime. Provider- and transport-agnostic.

export type ContentPart = { type: "text"; text: string };

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant";
      content?: ContentPart[];
      toolCalls?: ToolCall[];
      providerState?: unknown;
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export interface ToolCall {
  id: string;
  name: "read" | "write" | "edit" | "bash";
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export type FinishReason =
  "stop" | "tool_calls" | "length" | "error" | "cancelled";

export interface ModelRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelResponse {
  message: Message & { role: "assistant" };
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  providerState?: unknown;
  metadata?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; response: ModelResponse };

export interface AgentLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxExecutionMs: number;
  maxParallelToolCalls: number;
  maxToolOutputBytes: number;
  maxBashTimeMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxIterations: 40,
  maxToolCalls: 100,
  maxExecutionMs: 1_800_000,
  maxParallelToolCalls: 4,
  maxToolOutputBytes: 30_000,
  maxBashTimeMs: 120_000,
};
