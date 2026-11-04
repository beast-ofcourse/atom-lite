import type { AgentLimits } from "../types.js";
export type { AgentLimits };
import type { Message } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalContext } from "../runtime/approvals.js";
import type { ContextManager } from "../context/manager.js";
import type { ToolCall } from "../types.js";

export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_output";
      toolCallId: string;
      name: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
      diff?: string[];
    }
  | { type: "final"; text: string }
  | { type: "usage"; input?: number; output?: number }
  | { type: "model_switched"; provider: string; model: string }
  | { type: "skill_loaded"; name: string }
  | { type: "error"; message: string };

export interface AgentRuntimeOptions {
  provider: ProviderAdapter;
  model?: string;
  workspace?: string;
  tools: Tool[];
  limits?: Partial<AgentLimits>;
  systemPrompt?: string;
  approvals?: ApprovalContext;
  contextManager?: ContextManager;
  onEvent?: (event: AgentEvent) => void;
  effort?: string;
  bashConcurrency?: "serial" | "parallel";
}

export interface RunTurnParams {
  input: string;
  session: { messages: Message[]; append(m: Message): void };
  signal: AbortSignal;
}
