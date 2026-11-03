import type { AgentLimits } from "../types.js";
export type { AgentLimits };
import type { Message } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalContext } from "../runtime/approvals.js";
import type { ContextManager } from "../context/manager.js";

export interface AgentRuntimeOptions {
  provider: ProviderAdapter;
  model?: string;
  workspace?: string;
  tools: Tool[];
  limits?: Partial<AgentLimits>;
  systemPrompt?: string;
  approvals?: ApprovalContext;
  contextManager?: ContextManager;
}

export interface RunTurnParams {
  input: string;
  session: { messages: Message[]; append(m: Message): void };
  signal: AbortSignal;
}
