import type { AgentRuntimeOptions, ContextUsage } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, AgentLimits } from "../types.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { executeToolBatch } from "../runtime/scheduler.js";
import {
  touchFile as touchLspFile,
  getDiagnostics as getLspDiagnostics,
} from "../lsp/index.js";
import { ContextManager } from "../context/manager.js";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";
import { BackgroundTaskManager } from "../runtime/background-tasks.js";
import { CheckpointStore } from "../runtime/checkpoint-store.js";
import { TodoStore } from "../runtime/todos.js";
import { runModelTurn } from "./model-turn.js";
import { TurnRecorder } from "./turn-recorder.js";
import type { AgentPersona } from "../agents/registry.js";
import { composePersonaSystemPrompt } from "../agents/persona.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private workspace: string;
  private approvals: AgentRuntimeOptions["approvals"];
  private mode: "plan" | "yolo";
  private maxTokensPerSession: number | null;
  private maxTokensPerTurn: number | null;
  private totalTokensUsed: number;
  private contextManager: ContextManager;
  /** System prompt without any persona body, used when recomposing. */
  private baseSystemPrompt: string;
  private persona: AgentPersona | undefined;
  private onEvent: AgentRuntimeOptions["onEvent"];
  private tools: AgentRuntimeOptions["tools"];
  private effort: string;
  private bashConcurrency: "serial" | "parallel";
  private toolMap: Map<string, AgentRuntimeOptions["tools"][number]>;
  private limits: AgentLimits;
  private extensionDispatch: AgentRuntimeOptions["extensionDispatch"];
  private steeringQueue: string[] | undefined;

  private contextWindow: number | undefined;
  private contextUsed: number | undefined;
  private supportsVision: boolean | undefined;
  private backgroundTasks: BackgroundTaskManager;
  private todoStore: TodoStore;
  private checkpointingEnabled: boolean;
  private checkpointStoreOverride: CheckpointStore | undefined;
  private turnCheckpointed = false;
  private turnCheckpointId: string | null = null;
  private turnCheckpointStore: CheckpointStore | null = null;
  private turnIndex = 0;
  private todoStoreInjected: boolean;
  private todoTouchedThisTurn = false;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? options.provider.model ?? "default";
    this.workspace = options.workspace ?? process.cwd();
    this.approvals = options.approvals;
    this.mode = options.mode ?? "yolo";
    this.maxTokensPerSession = options.maxTokensPerSession ?? null;
    this.maxTokensPerTurn = options.maxTokensPerTurn ?? null;
    this.totalTokensUsed = 0;
    this.onEvent = options.onEvent;
    this.tools = options.tools;
    this.effort = options.effort ?? "medium";
    this.bashConcurrency = options.bashConcurrency ?? "serial";
    this.contextManager =
      options.contextManager ??
      new ContextManager({
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        maxInputTokens: null,
        reserveOutputTokens: 4096,
        compactAtPercent: 85,
        maxProjectInstructionBytes: 30000,
        provider: options.provider,
        model: options.model ?? options.provider.model ?? "default",
      });
    this.baseSystemPrompt =
      options.systemPrompt ?? this.contextManager.getSystemPrompt();
    this.persona = options.persona;
    if (this.persona) {
      this.contextManager.setSystemPrompt(
        composePersonaSystemPrompt(this.baseSystemPrompt, this.persona),
      );
    }
    this.toolMap = new Map(options.tools.map((t) => [t.definition.name, t]));
    this.refreshToolTokenOverhead();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.extensionDispatch = options.extensionDispatch;
    this.steeringQueue = options.steeringQueue;
    this.contextWindow = options.contextWindow;
    this.supportsVision = options.supportsVision;
    this.backgroundTasks =
      options.backgroundTasks ?? new BackgroundTaskManager();
    this.todoStore = options.todoStore ?? new TodoStore();
    this.todoStoreInjected = options.todoStore !== undefined;
    this.checkpointingEnabled = options.checkpointingEnabled ?? true;
    this.checkpointStoreOverride = options.checkpointStore;
    this.contextManager.setModelContextWindow(options.contextWindow);
  }

  switchModel(provider: AgentRuntimeOptions["provider"], model?: string): void {
    this.provider = provider;
    if (model) this.model = model;
    this.contextManager.setProvider(provider, this.model);
    // The new model has a fresh window; usage from the old one is meaningless.
    this.contextUsed = undefined;
    this.onEvent?.({
      type: "model_switched",
      provider: provider.id,
      model: this.model,
    });
    this.emitContextUsage();
  }

  /** Update the context window for the selected model (metadata may arrive late). */
  setContextWindow(window: number | undefined): void {
    const next =
      typeof window === "number" && Number.isFinite(window) && window > 0
        ? Math.floor(window)
        : undefined;
    if (next === this.contextWindow) return;
    this.contextWindow = next;
    this.contextManager.setModelContextWindow(next);
    this.emitContextUsage();
  }

  setSupportsVision(value: boolean | undefined): void {
    this.supportsVision = value;
  }

  private injectCompletedBackgroundTasks(session: {
    appendMessage(m: any): void;
  }): void {
    for (const t of this.backgroundTasks.drainCompleted()) {
      session.appendMessage({
        role: "system",
        content: `[background task ${t.id} ${t.status}] ${t.output}`,
      });
      this.onEvent?.({
        type: "background_task_complete",
        id: t.id,
        status: t.status,
        exitCode: t.exitCode,
      });
    }
  }

  getContextUsage(): ContextUsage {
    return { used: this.contextUsed, window: this.contextWindow };
  }

  /** Reset per-session context usage (e.g. when starting a new session). */
  resetContextUsage(): void {
    this.contextUsed = undefined;
    this.contextManager.setSessionMemory(null);
    this.contextManager.resetUsage();
    this.emitContextUsage();
  }

  private emitContextUsage(): void {
    this.onEvent?.({
      type: "context_usage",
      used: this.contextUsed,
      window: this.contextWindow,
    });
  }

  setEffort(effort: string): void {
    this.effort = effort;
  }

  setMode(mode: "plan" | "yolo"): void {
    this.mode = mode;
  }

  getMode(): "plan" | "yolo" {
    return this.mode;
  }

  /**
   * Switch the active persona without touching conversation history. The next
   * context build picks up the recomposed system prompt, temperature, and
   * permission policy.
   */
  setPersona(persona: AgentPersona | undefined): void {
    this.persona = persona;
    this.contextManager.setSystemPrompt(
      composePersonaSystemPrompt(this.baseSystemPrompt, persona),
    );
  }

  /** Force the next context build to rescan AGENTS.md and skills from disk. */
  invalidateContextCaches(): void {
    this.contextManager.invalidateCaches();
  }

  getPersona(): AgentPersona | undefined {
    return this.persona;
  }

  setSteeringQueue(queue: string[]): void {
    this.steeringQueue = queue;
  }

  async compactSession(
    session: {
      messages: Message[];
      appendMessage(m: Message): void;
      appendEvent?(partial: any): any;
    },
    focus?: string,
  ): Promise<string | null> {
    const summary = await this.contextManager.compactHistory(
      this.workspace,
      session.messages,
      focus,
    );
    if (summary) {
      this.contextManager.resetUsage();
      this.contextManager.setSessionMemory(
        summary,
        this.contextManager.getLastCompactionCoveredCount(),
      );
      if (typeof session.appendEvent === "function") {
        session.appendEvent({
          type: "context_compacted",
          summary,
          coveredCount: this.contextManager.getLastCompactionCoveredCount(),
        });
      }
    }
    return summary;
  }

  /** Replace the toolset, e.g. after MCP discovery or a list_changed refresh. */
  setTools(tools: AgentRuntimeOptions["tools"]): void {
    this.tools = tools;
    this.toolMap = new Map(tools.map((t) => [t.definition.name, t]));
    this.refreshToolTokenOverhead();
  }

  private refreshToolTokenOverhead(): void {
    const overhead = (this.tools ?? []).reduce((sum, tool: any) => {
      try {
        return (
          sum + Math.ceil(JSON.stringify(tool.definition ?? tool).length / 4)
        );
      } catch {
        return sum;
      }
    }, 0);
    this.contextManager.setToolTokenOverhead?.(overhead);
  }

  getEffort(): string {
    return this.effort;
  }

  private restoreTodos(session: unknown): void {
    const events = (session as { events?: unknown[] }).events;
    if (!Array.isArray(events)) return;
    const latest = [...events]
      .reverse()
      .find((event: any) => event?.type === "todos_updated") as
      { todos?: unknown } | undefined;
    if (!latest) return;
    if (this.todoStoreInjected) {
      // Keep the caller-supplied store (and its identity) while seeding it
      // from the resumed session.
      this.todoStore.replace(Array.isArray(latest.todos) ? latest.todos : []);
      return;
    }
    this.todoStore = TodoStore.fromJSON(latest.todos);
  }

  private persistTodos(session: { appendEvent?(partial: any): any }): void {
    if (typeof session.appendEvent !== "function") return;
    session.appendEvent({
      type: "todos_updated",
      todos: this.todoStore.toJSON(),
    });
  }

  private isContinuation(text: string): boolean {
    // Match the whole message, not just its opening: "ok now fix the failing
    // test" is a new task, while "ok" is a continuation.
    return /^(please\s+)?(continue|proceed|go on|keep going|yes|yep|ok|okay|sure|do it|thanks|thank you|\?\?continue)(\s+please)?[.!]*$/i.test(
      text.trim(),
    );
  }

  private isQuestion(text: string): boolean {
    // Requests phrased as questions ("can you fix…") are tasks; genuine
    // questions start with a wh-word or auxiliary.
    if (/^(can|could|would|will)\s+you\b/i.test(text)) return false;
    return (
      /\?\s*$/.test(text) &&
      /^(what|why|how|when|where|who|which|is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(
        text,
      )
    );
  }

  /**
   * Capture each distinct user request in the ledger. This is deliberately
   * independent of the model: a new task cannot disappear just because the
   * model was still finishing the previous one.
   */
  private captureUserTask(
    input: string,
    session: { appendEvent?(partial: any): any },
  ): void {
    if (!this.toolMap.has("todo")) return;
    const text = input.replace(/\s+/g, " ").trim();
    if (!text || this.isContinuation(text) || this.isQuestion(text)) return;
    const captured = text.slice(0, 200);
    if (this.todoStore.contains(captured)) return;
    this.todoStore.add({ content: captured, status: "pending" });
    this.persistTodos(session);
  }

  private injectTodoLedger(
    messages: Message[],
    completionCheck: boolean,
  ): void {
    const ledger = this.todoStore.renderForPrompt({ completionCheck });
    if (!ledger) return;
    // Keep the ledger next to the system prompt, before compacted history.
    let index = 0;
    while (index < messages.length && messages[index].role === "system") {
      index++;
    }
    messages.splice(index, 0, { role: "system", content: ledger });
  }

  async runAgentTurn(
    input: string,
    session: {
      messages: Message[];
      appendMessage(m: Message): void;
      appendEvent?(partial: any): any;
    },
    signal: AbortSignal,
    options?: { requestId?: string },
  ): Promise<string> {
    // Restore any persisted session memory for resumed sessions.
    const events = (session as any).events;
    if (Array.isArray(events)) {
      const latest = [...events]
        .reverse()
        .find((e: any) => e?.type === "context_compacted");
      this.contextManager.setSessionMemory(
        typeof latest?.summary === "string" ? latest.summary : null,
        typeof latest?.coveredCount === "number"
          ? latest.coveredCount
          : undefined,
      );
    }
    this.restoreTodos(session);

    this.turnIndex += 1;
    // Resolve a per-turn correlation id once and reuse it for every model
    // call in the turn. Persisting it makes the request traceable after the
    // fact (session log + event consumers).
    const requestId = (options?.requestId ?? "").trim() || randomUUID();
    if (typeof (session as any).appendEvent === "function") {
      (session as any).appendEvent({
        type: "model_request_id",
        requestId,
        turn: this.turnIndex,
      });
    }
    this.onEvent?.({ type: "request_id", requestId });
    this.todoTouchedThisTurn = false;
    this.injectCompletedBackgroundTasks(session);
    this.turnCheckpointed = false;
    this.turnCheckpointId = null;
    this.turnCheckpointStore = null;
    this.captureUserTask(input, session);

    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: input }],
    });

    await this.extensionDispatch?.("turn_start", { type: "turn_start" });
    let completionNudges = 0;
    const maxCompletionNudges = 3;
    try {
      while (true) {
        // Drain any steering messages into the session before the next model turn.
        if (this.steeringQueue && this.steeringQueue.length > 0) {
          while (this.steeringQueue.length > 0) {
            const msg = this.steeringQueue.shift()!;
            session.appendMessage({
              role: "user",
              content: [{ type: "text", text: msg }],
            });
          }
        }
        if (signal.aborted) {
          throw new Error("USER_CANCELLED");
        }

        const messages = await this.contextManager.build(
          this.workspace,
          session.messages,
        );
        this.injectTodoLedger(
          messages,
          completionNudges > 0 && this.todoStore.openCount() > 0,
        );
        await this.extensionDispatch?.("context_build", {
          type: "context_build",
          messages,
        });
        if (this.contextManager.consumeCompaction()) {
          // Prefer an estimate over "unknown" so the TUI keeps showing a
          // number; the next assistant response replaces it with real usage.
          const estimate = this.contextManager.getLastBuildTokens?.();
          this.contextUsed =
            typeof estimate === "number" && estimate > 0
              ? estimate
              : this.contextUsed;
          this.emitContextUsage();
          const summary = this.contextManager.consumeCompactionSummary();
          const coveredCount =
            this.contextManager.consumeCompactionCoveredCount();
          if (summary && typeof (session as any).appendEvent === "function") {
            (session as any).appendEvent({
              type: "context_compacted",
              summary,
              coveredCount,
            });
          }
        }

        let response: any;
        let streamedText = "";
        let thinkingBuffer = "";
        await this.extensionDispatch?.("before_provider_request", {
          type: "before_provider_request",
          messages,
          tools: this.tools.map((t) => t.definition),
        });
        for await (const ev of runModelTurn({
          provider: this.provider,
          model: this.model,
          messages,
          tools: this.tools.map((t) => t.definition),
          effort: this.effort,
          temperature: this.persona?.temperature,
          signal,
          requestId,
        })) {
          if (ev.type === "thinking_delta") {
            thinkingBuffer += ev.text;
            this.onEvent?.({ type: "thinking_delta", text: ev.text });
          } else if (ev.type === "assistant_delta") {
            streamedText += ev.text;
            this.onEvent?.({ type: "assistant_delta", text: ev.text });
          } else if (ev.type === "assistant_text") {
            streamedText = ev.text;
            this.onEvent?.({ type: "assistant_text", text: ev.text });
          } else if (ev.type === "final") {
            response = ev.response;
            streamedText = ev.streamedText;
            if (thinkingBuffer) {
              if (response?.message && !response.message.thinking)
                response.message.thinking = thinkingBuffer;
              if (!response?.metadata?.thinking) {
                response.metadata = {
                  ...(response?.metadata ?? {}),
                  thinking: thinkingBuffer,
                };
              }
            } else if (
              response?.metadata?.thinking &&
              response?.message &&
              !response.message.thinking
            ) {
              response.message.thinking = response.metadata.thinking;
            }
          }
        }

        await this.extensionDispatch?.("after_provider_response", {
          type: "after_provider_response",
          response,
        });
        const recorder = new TurnRecorder({
          session,
          onEvent: this.onEvent as ((event: unknown) => void) | undefined,
          extensionDispatch: this.extensionDispatch,
        });
        const text = await recorder.recordAssistant(response, streamedText);

        if (response.usage) {
          const used =
            (response.usage.input ?? 0) + (response.usage.output ?? 0);
          if (used > 0) {
            // The latest assistant step's prompt + generated tokens is the
            // current context occupancy (not a cumulative session total).
            this.contextUsed = used;
            this.emitContextUsage();
            this.contextManager.noteUsage?.(used);
            const inputTokens = response.usage?.input ?? used;
            if (
              this.contextWindow !== undefined &&
              inputTokens > this.contextWindow
            ) {
              this.setContextWindow(inputTokens);
            }
          }
          const turnTokens = used > 0 ? used : 0;
          if (
            this.maxTokensPerTurn !== null &&
            turnTokens > this.maxTokensPerTurn
          ) {
            this.onEvent?.({
              type: "budget_warning",
              scope: "turn",
              used: turnTokens,
              limit: this.maxTokensPerTurn,
            });
          }
          if (turnTokens > 0) {
            this.totalTokensUsed += turnTokens;
          }
          if (
            this.maxTokensPerSession !== null &&
            this.totalTokensUsed > this.maxTokensPerSession
          ) {
            this.onEvent?.({
              type: "budget_warning",
              scope: "session",
              used: this.totalTokensUsed,
              limit: this.maxTokensPerSession,
            });
            await this.extensionDispatch?.("agent_settled", {
              type: "agent_settled",
            });
            return "TOKEN_BUDGET_REACHED";
          }
        }

        const toolCalls = response.toolCalls ?? [];
        if (toolCalls.length === 0) {
          // turn_end / agent_before_settle continuation handling.
          let continued = false;
          const turnResults = await this.extensionDispatch?.("turn_end", {
            type: "turn_end",
          });
          for (const r of turnResults ?? []) {
            if (r && r.continue) continued = true;
          }
          if (continued) {
            continue;
          }
          const settleResults = await this.extensionDispatch?.(
            "agent_before_settle",
            { type: "agent_before_settle" },
          );
          for (const r of settleResults ?? []) {
            if (r && r.continue) continued = true;
          }
          if (continued) {
            continue;
          }
          // Task ledger completion gate: only gate when the model actually
          // touched the ledger this turn, and nudge a bounded number of times
          // so an unresolvable item cannot loop forever.
          if (
            this.toolMap.has("todo") &&
            this.todoTouchedThisTurn &&
            completionNudges < maxCompletionNudges &&
            this.todoStore.openCount() > 0
          ) {
            completionNudges += 1;
            this.onEvent?.({
              type: "task_ledger_open",
              pending: this.todoStore.openCount(),
              todos: this.todoStore.list(),
            });
            continue;
          }
          // Discard a checkpoint that produced no changes.
          if (this.turnCheckpointId && this.turnCheckpointStore) {
            try {
              if (
                this.turnCheckpointStore.isAtCheckpoint(this.turnCheckpointId)
              ) {
                const m = this.turnCheckpointStore.get(this.turnCheckpointId);
                if (m) {
                  this.turnCheckpointStore.discard(this.turnCheckpointId);
                }
                this.turnCheckpointId = null;
              }
            } catch {
              // best effort
            }
          }
          await this.extensionDispatch?.("agent_settled", {
            type: "agent_settled",
          });
          return text;
        }

        // Emit tool_call events; allow mutation and block decisions.
        const blocked = new Set<string>();
        let terminate = false;
        for (const call of toolCalls) {
          const payload: any = {
            type: "tool_call",
            toolCallId: call.id,
            name: call.name,
            input: call.arguments,
          };
          const results = await this.extensionDispatch?.("tool_call", payload);
          // Apply in-place mutation.
          if (payload.input && payload.input !== call.arguments) {
            call.arguments = payload.input;
          }
          for (const r of results ?? []) {
            if (r && typeof r === "object") {
              if (r.block) blocked.add(call.id);
              if (r.terminate) terminate = true;
              if (r.input) call.arguments = r.input;
            }
          }
        }

        const ctx = {
          workspace: this.workspace,
          mode: this.mode,
          supportsVision: this.supportsVision,
          backgroundTasks: this.backgroundTasks,
          todos: this.todoStore,
          signal,
          maxBashTimeMs: this.limits.maxBashTimeMs,
          maxToolOutputBytes: this.limits.maxToolOutputBytes,
          approvals: this.approvals,
          agentPermissions: this.persona?.permissions,
          onToolOutput: (
            call: { id: string; name: string },
            stream: "stdout" | "stderr",
            text: string,
          ) => {
            this.onEvent?.({
              type: "tool_output",
              toolCallId: call.id,
              name: call.name,
              stream,
              text,
            });
            void this.extensionDispatch?.("tool_execution_update", {
              type: "tool_execution_update",
              toolCallId: call.id,
              name: call.name,
              stream,
              text,
            });
          },
        };

        // Wrapped tool map emits tool_execution_start/end.
        const wrappedToolMap = new Map(this.toolMap);
        for (const [name, tool] of this.toolMap) {
          wrappedToolMap.set(name, {
            ...tool,
            execute: async (call: any, ctx2: any) => {
              await this.extensionDispatch?.("tool_execution_start", {
                type: "tool_execution_start",
                toolCallId: call.id,
                name: call.name,
                args: call.arguments,
              });
              let result: any;
              try {
                result = await tool.execute(call, ctx2);
              } catch (err) {
                result = {
                  toolCallId: call.id,
                  name: call.name,
                  content: `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`,
                  isError: true,
                };
              }
              await this.extensionDispatch?.("tool_execution_end", {
                type: "tool_execution_end",
                toolCallId: call.id,
                name: call.name,
                result,
                isError: result?.isError,
              });
              return result;
            },
          });
        }

        const blockedResults = new Map<string, any>();
        for (const call of toolCalls) {
          if (!blocked.has(call.id)) continue;
          const reason = "blocked by extension";
          const r = {
            toolCallId: call.id,
            name: call.name,
            content: reason,
            isError: true,
          };
          blockedResults.set(call.id, r);
          await this.extensionDispatch?.("tool_execution_start", {
            type: "tool_execution_start",
            toolCallId: call.id,
            name: call.name,
            args: call.arguments,
          });
          await this.extensionDispatch?.("tool_execution_end", {
            type: "tool_execution_end",
            toolCallId: call.id,
            name: call.name,
            result: r,
            isError: true,
          });
        }

        // Capture a checkpoint before the first mutating batch of this turn.
        const readOnly = new Set([
          "read",
          "grep",
          "glob",
          "webfetch",
          "websearch",
          "task",
          "todo",
        ]);
        const hasMutating = toolCalls.some(
          (c: any) =>
            !blocked.has(c.id) &&
            !readOnly.has(c.name) &&
            this.toolMap.get(c.name)?.annotations?.readOnlyHint !== true,
        );
        if (hasMutating && !this.turnCheckpointed) {
          this.turnCheckpointed = true;
          if (this.checkpointingEnabled) {
            const store =
              this.checkpointStoreOverride ??
              new CheckpointStore(
                (session as any).workspace ?? this.workspace,
                (session as any).id ?? "session",
                { enabled: this.checkpointingEnabled },
              );
            this.turnCheckpointStore = store;
            const avail = store.isAvailable();
            if (avail.available) {
              try {
                const m =
                  typeof (store as any).createAsync === "function"
                    ? await (store as any).createAsync(
                        this.turnIndex,
                        `turn ${this.turnIndex}`,
                      )
                    : store.create(this.turnIndex, `turn ${this.turnIndex}`);
                this.turnCheckpointId = m.id;
                try {
                  if (typeof (session as any).appendEvent === "function") {
                    (session as any).appendEvent({
                      type: "checkpoint_created",
                      checkpointId: m.id,
                      turn: this.turnIndex,
                      fileCount: m.files.length,
                      bytes: m.bytes,
                      truncated: m.truncated === true,
                    });
                  }
                } catch {
                  // best effort
                }
                this.onEvent?.({ type: "checkpoint_created", id: m.id });
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                try {
                  if (typeof (session as any).appendEvent === "function") {
                    (session as any).appendEvent({
                      type: "checkpoint_failed",
                      turn: this.turnIndex,
                      reason,
                    });
                  }
                } catch {
                  // best effort
                }
                this.onEvent?.({
                  type: "checkpoint_failed",
                  reason,
                });
              }
            } else {
              this.onEvent?.({
                type: "checkpoint_unavailable",
                reason: avail.reason,
              });
            }
          }
        }

        const execCalls = toolCalls.filter((c: any) => !blocked.has(c.id));
        for (const call of execCalls) {
          const pathArg = (call as any)?.arguments?.path;
          if (typeof pathArg === "string") {
            void touchLspFile(path.resolve(this.workspace, pathArg)).catch(
              () => {},
            );
          }
        }
        const execResults = await executeToolBatch(
          execCalls,
          wrappedToolMap,
          ctx,
          this.limits.maxParallelToolCalls,
          signal,
          undefined,
          this.bashConcurrency,
        );
        if (
          execResults.some((result: any) => result?.name === "todo") &&
          this.toolMap.has("todo")
        ) {
          this.todoTouchedThisTurn = true;
          this.persistTodos(session);
        }

        for (const r of execResults) {
          const call = toolCalls.find((c: any) => c.id === r.toolCallId);
          if (
            call &&
            (call.name === "write" || call.name === "edit") &&
            typeof (call as any).arguments?.path === "string"
          ) {
            try {
              const diags = await getLspDiagnostics(
                path.resolve(this.workspace, (call as any).arguments.path),
              );
              const messages = [...diags.values()]
                .flat()
                .map((d: any) => d.message);
              if (messages.length > 0) {
                r.content = `${r.content}\nLSP diagnostics:\n${messages.join("\n")}`;
              }
            } catch {
              // Best effort.
            }
          }
        }

        const resultMap = new Map<string, any>();
        for (const r of blockedResults.values()) resultMap.set(r.toolCallId, r);
        for (const r of execResults) {
          // Emit tool_result event and allow patches.
          const payload: any = {
            type: "tool_result",
            toolCallId: r.toolCallId,
            name: r.name,
            content: r.content,
            details: r.details,
            structuredContent: r.structuredContent,
            isError: r.isError,
            usage: r.usage,
          };
          await this.extensionDispatch?.("tool_result", payload);
          r.content = payload.content ?? r.content;
          r.details = payload.details ?? r.details;
          r.structuredContent =
            payload.structuredContent ?? r.structuredContent;
          r.isError = payload.isError ?? r.isError;
          r.usage = payload.usage ?? r.usage;
          resultMap.set(r.toolCallId, r);
        }

        const orderedResults = toolCalls
          .map((c: any) => resultMap.get(c.id))
          .filter(Boolean);
        for (const r of orderedResults) {
          recorder.recordToolResult(r);
        }

        // Inject completed background task results as system messages.
        const completed = this.backgroundTasks.drainCompleted();
        for (const t of completed) {
          session.appendMessage({
            role: "system",
            content: `[background task ${t.id} completed] ${t.output}`,
          });
        }

        if (terminate) {
          // Discard a checkpoint that produced no changes.
          if (this.turnCheckpointId && this.turnCheckpointStore) {
            try {
              if (
                this.turnCheckpointStore.isAtCheckpoint(this.turnCheckpointId)
              ) {
                const m = this.turnCheckpointStore.get(this.turnCheckpointId);
                if (m) {
                  this.turnCheckpointStore.discard(this.turnCheckpointId);
                }
                this.turnCheckpointId = null;
              }
            } catch {
              // best effort
            }
          }
          await this.extensionDispatch?.("agent_settled", {
            type: "agent_settled",
          });
          return text;
        }
      }
      // The while(true) loop always returns or throws from inside; this line is unreachable but satisfies the return type.
      return "TASK_BUDGET_REACHED";
    } finally {
      try {
        await (session as any).flush?.();
      } catch {
        // Best-effort durability; never fail the turn on flush errors.
      }
    }
  }
}
