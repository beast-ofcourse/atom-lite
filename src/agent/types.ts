import type { AgentLimits } from "../types.js";
export type { AgentLimits };
import type { Message } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalContext } from "../runtime/approvals.js";
import type { QuestionContext } from "../runtime/questions.js";
import type { ContextManager } from "../context/manager.js";
import type { RepoMapOptions } from "../context/repoMap.js";
import type { WebConfig } from "../config/schema.js";
import type { UsageLedger } from "../usage/ledger.js";
import type { AtomEvent } from "../extensions/types.js";
import type { LockManager } from "../runtime/locks.js";

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
  | { type: "usage"; input?: number; output?: number; elapsedMs?: number }
  | { type: "context_usage"; used?: number; window?: number; tokens?: number | null; contextWindow?: number | null; percent?: number | null }
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
  | {
      type: "task_ledger_open";
      pending: number;
      todos: import("../runtime/todos.js").TodoItem[];
    }
  | {
      type: "goal_state";
      goal: import("../runtime/goal.js").GoalState | null;
    }
  | {
      type: "ledger_state";
      todos: import("../runtime/todos.js").TodoItem[];
      open: number;
    }
  | { type: "compaction_continuation"; text: string }
  | {
      type: "context_compaction_started";
      model: string;
      strategy: string;
    }
  | {
      type: "context_compaction_failed";
      model: string;
      strategy: string;
      reason: string;
    }
  | { type: "request_id"; requestId: string }
  | { type: "response_truncated"; model: string }
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
  /** Interactive question bridge. Absent clients cannot ask the user. */
  questions?: QuestionContext;
  /** Initial agent mode. Defaults to yolo for programmatic use. */
  mode?: "plan" | "yolo";
  /** Optional per-call usage ledger. Inert when absent. */
  usageLedger?: UsageLedger;
  /** Recent-tail token budget for a default context manager. */
  keepTokens?: number;
  /** Prepare summaries ahead of the trigger in a default context manager. */
  background?: boolean;
  /** Opt-in cache keep-alive settings. */
  warming?: import("../config/schema.js").Config["context"]["warming"];
  /** Resolved compaction policy for a default context manager. */
  compactionStrategy?: "auto" | "summary" | "native";
  /** Compaction reserve for a default context manager. */
  buffer?: string | number | null;
  /** Prompt-cache layout mode for a default context manager. */
  cacheMode?: "off" | "automatic" | "explicit";
  /** Repo-map settings for a default context manager. */
  repoMap?: RepoMapOptions;
  /** Web tool settings from config, passed to every tool call. */
  web?: WebConfig;
  /** Optional session token budget (hard stop when exceeded). */
  maxTokensPerSession?: number | null;
  /** Optional per-turn token soft warning threshold. */
  maxTokensPerTurn?: number | null;
  contextManager?: ContextManager;
  onEvent?: (event: AgentEvent) => void;
  effort?: string;
  reasoning?: string;
  bashConcurrency?: "serial" | "parallel";
  /** Selected model's context window, when known. */
  contextWindow?: number;
  /** Whether the selected model supports vision input. */
  supportsVision?: boolean;
  /** Background task manager override (defaults to a new manager). */
  backgroundTasks?: import("../runtime/background-tasks.js").BackgroundTaskManager;
  /** Shared lock manager for cross-batch tool exclusion (defaults to a new one). */
  lockManager?: LockManager;
  /** Task ledger override (defaults to a new in-memory store). */
  todoStore?: import("../runtime/todos.js").TodoStore;
  /** Goal store override (defaults to a new in-memory store). */
  goalStore?: import("../runtime/goal.js").GoalStore;
  /** Optional steering queue drained into the turn between iterations. */
  steeringQueue?: string[];
  /** Optional dispatcher for typed extension events. */
  extensionDispatch?: (
    event: AtomEvent,
    payload: any,
  ) => Promise<any[]> | any[];
}

/** A session event read back from the durable log. Event shapes are additive. */
export interface SessionEventLike {
  type?: string;
  [key: string]: unknown;
}

/** The session surface an agent turn mutates. Replaces ad-hoc `as any` shapes. */
export interface AgentSession {
  id?: string;
  messages: Message[];
  events?: SessionEventLike[];
  appendMessage(m: Message): void;
  appendEvent?(partial: Record<string, unknown>): unknown;
  flush?(): Promise<void> | void;
}

export interface ContextUsage {
  /** Tokens occupied after the latest assistant response, when known. */
  used?: number;
  /** Selected model's context window, when known. */
  window?: number;
  /** New shape: token count, may be null when unknown. */
  tokens?: number | null;
  /** New shape: resolved model context window, may be null when unknown. */
  contextWindow?: number | null;
  /** New shape: percentage of the window, may be null when unknown. */
  percent?: number | null;
}

export interface RunTurnParams {
  input: string;
  session: { messages: Message[]; append(m: Message): void };
  signal: AbortSignal;
}
