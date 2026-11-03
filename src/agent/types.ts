import type { AgentLimits } from "../types.js";
export type { AgentLimits };
import type { Message } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

export interface AgentRuntimeOptions {
  provider: ProviderAdapter;
  tools: ToolDefinition[];
  limits?: Partial<AgentLimits>;
  systemPrompt?: string;
}

export interface RunTurnParams {
  input: string;
  session: { messages: Message[]; append(m: Message): void };
  signal: AbortSignal;
}