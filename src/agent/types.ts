import type { AgentLimits } from "../types.js";
export type { AgentLimits };
import type { Message } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalContext } from "../runtime/approvals.js";
import type { ContextManager } from "../context/manager.js";

export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
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
  | { type: "context_usage"; used?: number; window?: number }
  | { type: "model_switched"; provider: string; model: string }
  | { type: "skill_loaded"; name: string }
  | {
      type: "budget_warning";
      scope: "turn" | "session";
      used: number;
      limit: number;
    }
  | {
      type: "background_task_complete";
      id: string;
      status: string;
      exitCode: number | null;
    }
  | { type: "checkpoint_created"; id: string }
  | { type: "checkpoint_failed"; reason: string }
  | { type: "checkpoint_unavailable"; reason?: string }
  | {
      type: "task_ledger_open";
      pending: number;
      todos: import("../runtime/todos.js").TodoItem[];
    }
  | { type: "request_id"; requestId: string }
  | { type: "error"; message: string };

export interface AgentRuntimeOptions {
  provider: ProviderAdapter;
  model?: string;
  workspace?: string;
  tools: Tool[];
  limits?: Partial<AgentLimits>;
  systemPrompt?: string;
  /** Active primary persona. Applies its prompt, temperature, and permissions. */
  persona?: import("../agents/registry.js").AgentPersona;
  approvals?: ApprovalContext;
  /** Initial agent mode. Defaults to yolo for programmatic use. */
  mode?: "plan" | "yolo";
  /** Optional session token budget (hard stop when exceeded). */
  maxTokensPerSession?: number | null;
  /** Optional per-turn token soft warning threshold. */
  maxTokensPerTurn?: number | null;
  contextManager?: ContextManager;
  onEvent?: (event: AgentEvent) => void;
  effort?: string;
  bashConcurrency?: "serial" | "parallel";
  /** Selected model's context window, when known. */
  contextWindow?: number;
  /** Whether the selected model supports vision input. */
  supportsVision?: boolean;
  /** Background task manager override (defaults to a new manager). */
  backgroundTasks?: import("../runtime/background-tasks.js").BackgroundTaskManager;
  /** Task ledger override (defaults to a new in-memory store). */
  todoStore?: import("../runtime/todos.js").TodoStore;
  /** Whether checkpointing is enabled for this runtime. Defaults to true. */
  checkpointingEnabled?: boolean;
  /** Checkpoint store override (defaults to a new store per turn). */
  checkpointStore?: import("../runtime/checkpoint-store.js").CheckpointStore;
  /** Optional steering queue drained into the turn between iterations. */
  steeringQueue?: string[];
  /** Optional dispatcher for Pi extension events. */
  extensionDispatch?: (event: string, payload: any) => Promise<any[]> | any[];
}

export interface ContextUsage {
  /** Tokens occupied after the latest assistant response, when known. */
  used?: number;
  /** Selected model's context window, when known. */
  window?: number;
}

export interface RunTurnParams {
  input: string;
  session: { messages: Message[]; append(m: Message): void };
  signal: AbortSignal;
}
