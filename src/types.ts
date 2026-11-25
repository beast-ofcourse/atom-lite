// Canonical types shared across the runtime. Provider- and transport-agnostic.
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export type ModelThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevel = Exclude<ModelThinkingLevel, "off">;

export type ThinkingLevelMap = Partial<
  Record<ModelThinkingLevel, string | null>
>;

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface ModelResponse {
  message: Message & { role: "assistant" };
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  /** Wall time spent waiting for this provider call, measured by the runtime. */
  elapsedMs?: number;
  /** Wall time spent in the reasoning phase of this provider call, when reported. */
  thinkingMs?: number;
  /** Neutral thinking level requested for this response. */
  thinkingLevel?: ModelThinkingLevel;
  /** Provider-native thinking value actually sent for this response. */
  providerThinkingLevel?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cacheRead?: number;
  /** Tokens written into the provider's prompt cache, when reported. */
  cacheWrite?: number;
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
  /** Reports time spent serializing the provider request body. */
  onSerialized?: (elapsedMs: number) => void;
}

export interface ModelResponse {
  message: Message & { role: "assistant" };
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  /** Wall time spent waiting for this provider call, measured by the runtime. */
  elapsedMs?: number;
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
