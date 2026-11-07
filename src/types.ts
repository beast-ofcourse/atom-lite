// Canonical types shared across the runtime. Provider- and transport-agnostic.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ImagePart = { data: string; mime: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime: string };

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant";
      content?: ContentPart[];
      toolCalls?: ToolCall[];
      providerState?: unknown;
      thinking?: string;
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      images?: ImagePart[];
      isError?: boolean;
      diff?: string[];
    };

export interface ToolCall {
  id: string;
  /** Built-in tool names are validated by each tool; MCP names are dynamic. */
  name: string;
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
  requestId?: string;
}

export interface ModelResponse {
  message: Message & { role: "assistant" };
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  providerState?: unknown;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export type ModelStreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; response: ModelResponse };

export interface AgentLimits {
  maxParallelToolCalls: number;
  maxToolOutputBytes: number;
  maxBashTimeMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxParallelToolCalls: 10,
  maxToolOutputBytes: 30_000,
  maxBashTimeMs: 120_000,
};
