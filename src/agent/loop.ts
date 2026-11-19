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
import { discoverInstructionPaths } from "../context/instructions.js";
import {
  foldInstructionBaseline,
  initialBaseline,
  recordInstructionChange,
  type InstructionBaselineState,
} from "../context/instruction-baseline.js";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";
import { BackgroundTaskManager } from "../runtime/background-tasks.js";
import { TodoStore } from "../runtime/todos.js";
import {
  GoalStore,
  checkGoalCompletion,
  type GoalState,
} from "../runtime/goal.js";
import { runModelTurn } from "./model-turn.js";
import { TurnRecorder } from "./turn-recorder.js";
import type { AgentPersona } from "../agents/registry.js";
import { composePersonaSystemPrompt } from "../agents/persona.js";

/** The minimal session surface the runtime needs to append state events. */
type EventSession = { appendEvent?(partial: any): any };

/** Find the newest event of a given type without copying the event log. */
function latestEvent(session: unknown, type: string): any | undefined {
  const events = (session as { events?: unknown[] })?.events;
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as any)?.type === type) return events[i];
  }
  return undefined;
}

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private workspace: string;
  private approvals: AgentRuntimeOptions["approvals"];
  private questions: AgentRuntimeOptions["questions"];
  private web: AgentRuntimeOptions["web"];
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
  private usageLedger: AgentRuntimeOptions["usageLedger"];
  private steeringQueue: string[] | undefined;

  private contextWindow: number | undefined;
  private contextUsed: number | undefined;
  private supportsVision: boolean | undefined;
  private backgroundTasks: BackgroundTaskManager;
  private todoStore: TodoStore;
  private goalStore: GoalStore;
  private turnIndex = 0;
  private todoStoreInjected: boolean;
  private goalStoreInjected: boolean;
  private todoTouchedThisTurn = false;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? options.provider.model ?? "default";
    this.workspace = options.workspace ?? process.cwd();
    this.approvals = options.approvals;
    this.questions = options.questions;
    this.web = options.web;
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
        usageLedger: options.usageLedger,
        keepTokens: options.keepTokens,
        buffer: options.buffer,
        cacheMode: options.cacheMode,
        repoMap: options.repoMap,
      });
    this.contextManager.setCompactionLifecycleCallback((phase, detail) => {
      this.onEvent?.(
        phase === "started"
          ? { type: "context_compaction_started", ...detail }
          : {
              type: "context_compaction_failed",
              ...detail,
              reason: detail.reason ?? "unknown",
            },
      );
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
    this.usageLedger = options.usageLedger;
    this.steeringQueue = options.steeringQueue;
    this.contextWindow = options.contextWindow;
    this.supportsVision = options.supportsVision;
    this.backgroundTasks =
      options.backgroundTasks ?? new BackgroundTaskManager();
    this.todoStore = options.todoStore ?? new TodoStore();
    this.todoStoreInjected = options.todoStore !== undefined;
    this.goalStore = options.goalStore ?? new GoalStore();
    this.goalStoreInjected = options.goalStore !== undefined;
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

  /** Point subsequent tools and approvals at a different workspace. */
  setWorkspace(workspace: string): void {
    this.workspace = workspace;
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

  /** Register instruction files found beside a path the agent just read. */
  noteReadPath(readPath: string): void {
    try {
      const discovered = discoverInstructionPaths(this.workspace, readPath);
      this.contextManager.noteDiscoveredInstructions(discovered);
    } catch {
      // Discovery is best effort; a read must not fail because of it.
    }
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
      events?: unknown[];
      appendMessage(m: Message): void;
      appendEvent?(partial: any): any;
    },
    focus?: string,
  ): Promise<string | null> {
    this.syncStaticContext(false, this.activeFiles(session));
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
          ...(this.contextManager.getLastCompactionCheckpoint() ?? {
            schemaVersion: 1,
            summary,
            coveredCount: this.contextManager.getLastCompactionCoveredCount(),
            coveredTokens: 0,
            keptCount: 0,
            model: this.model,
            strategy: "summary",
          }),
        });
      }
      const stored = latestEvent(session, "instruction_baseline");
      const currentState =
        stored?.schemaVersion === 1 &&
        Array.isArray(stored.baseline) &&
        Array.isArray(stored.updates)
          ? (stored as unknown as InstructionBaselineState)
          : initialBaseline(
              this.contextManager.getInstructionTexts(this.workspace),
              (session.events?.length ?? 0) + 1,
            );
      const folded = foldInstructionBaseline(
        currentState,
        this.contextManager.getInstructionTexts(this.workspace),
        (session.events?.length ?? 0) + 1,
      );
      this.persistInstructionBaseline(folded, session);
      this.contextManager.setInstructionState(folded);
      this.mirrorContinuation(this.contextManager.getContinuation(), session);
    }
    return summary;
  }

  /**
   * Replace the event consumer. The TUI uses this at startup; the web server
   * uses it when it owns the runtime. One sink at a time, by design.
   */
  setEventSink(sink: AgentRuntimeOptions["onEvent"]): void {
    this.onEvent = sink;
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
    const latest = latestEvent(session, "todos_updated") as
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

  private persistTodos(session: EventSession): void {
    if (typeof session.appendEvent !== "function") return;
    session.appendEvent({
      type: "todos_updated",
      todos: this.todoStore.toJSON(),
    });
  }

  private restoreGoal(session: unknown): void {
    const latest = latestEvent(session, "goal_updated") as
      { goal?: unknown } | undefined;
    if (!latest) return;
    if (this.goalStoreInjected) this.goalStore.replace(latest.goal);
    else this.goalStore = GoalStore.fromJSON(latest.goal);
  }

  private persistGoal(session: EventSession): void {
    if (typeof session.appendEvent !== "function") return;
    session.appendEvent({
      type: "goal_updated",
      goal: this.goalStore.toJSON(),
    });
  }

  private emitGoalState(): void {
    this.onEvent?.({ type: "goal_state", goal: this.goalStore.get() });
  }

  private emitLedgerState(): void {
    this.onEvent?.({
      type: "ledger_state",
      todos: this.todoStore.list(),
      open: this.todoStore.openCount(),
    });
  }

  private commitGoal(session?: {
    appendEvent?(partial: any): any;
  }): GoalState | null {
    if (session) this.persistGoal(session);
    this.emitGoalState();
    return this.goalStore.get();
  }

  getGoal(): GoalState | null {
    return this.goalStore.get();
  }

  getTodos(): import("../runtime/todos.js").TodoItem[] {
    return this.todoStore.list();
  }

  openTodoCount(): number {
    return this.todoStore.openCount();
  }

  setGoal(statement: string, session?: EventSession): GoalState {
    this.goalStore.set(statement);
    return this.commitGoal(session)!;
  }

  setGoalCriteria(criteria: string[], session?: EventSession): GoalState {
    this.goalStore.setCriteria(criteria);
    return this.commitGoal(session)!;
  }

  setGoalConstraints(value: string, session?: EventSession): GoalState {
    this.goalStore.setConstraints(value);
    return this.commitGoal(session)!;
  }

  pauseGoal(session?: EventSession): GoalState | null {
    const before = this.goalStore.status;
    const goal = this.goalStore.pause();
    if (before !== "paused" && goal?.status === "paused") {
      this.commitGoal(session);
    }
    return goal;
  }

  resumeGoal(session?: EventSession): GoalState | null {
    const before = this.goalStore.status;
    const goal = this.goalStore.resume();
    if (before === "paused" && goal?.status === "active") {
      this.commitGoal(session);
    }
    return goal;
  }

  clearGoal(session?: EventSession): void {
    this.goalStore.clear();
    this.commitGoal(session);
  }

  clearLedger(session?: EventSession): void {
    this.todoStore.replace([]);
    if (session) this.persistTodos(session);
    this.emitLedgerState();
  }

  completeGoal(
    evidence?: string,
    session?: EventSession,
  ): {
    ok: boolean;
    unmet: string[];
    goal: GoalState | null;
  } {
    const goal = this.goalStore.get();
    if (!goal) return { ok: false, unmet: [], goal: null };
    const check = checkGoalCompletion(goal, this.todoStore.list(), evidence);
    if (!check.complete) {
      return { ok: false, unmet: check.unmet, goal };
    }
    const complete = this.goalStore.complete();
    this.commitGoal(session);
    return { ok: true, unmet: [], goal: complete };
  }

  /** Explicit state refresh when the CLI switches sessions. */
  restoreSessionState(session: unknown): void {
    const goalEvent = latestEvent(session, "goal_updated") as
      { goal?: unknown } | undefined;
    const ledgerEvent = latestEvent(session, "todos_updated") as
      { todos?: unknown } | undefined;
    if (this.goalStoreInjected) {
      this.goalStore.replace(goalEvent?.goal ?? null);
    } else {
      this.goalStore = goalEvent
        ? GoalStore.fromJSON(goalEvent.goal)
        : new GoalStore();
    }
    if (this.todoStoreInjected) {
      this.todoStore.replace(
        Array.isArray(ledgerEvent?.todos) ? ledgerEvent!.todos : [],
      );
    } else {
      this.todoStore = ledgerEvent
        ? TodoStore.fromJSON(ledgerEvent.todos)
        : new TodoStore();
    }
    this.emitGoalState();
    this.emitLedgerState();
  }

  /** Clear both stores for `/new`. */
  resetSessionState(session?: EventSession): void {
    this.goalStore.clear();
    this.todoStore.replace([]);
    if (session) {
      this.persistGoal(session);
      this.persistTodos(session);
    }
    this.emitGoalState();
    this.emitLedgerState();
  }

  private continuationInput(): import("../context/manager.js").ContextStaticState["continuation"] {
    const goal = this.goalStore.get();
    const open = this.todoStore
      .list()
      .filter(
        (item) => item.status === "pending" || item.status === "in_progress",
      );
    if (!goal && open.length === 0) return null;
    const current = open[0];
    return {
      statement: goal?.statement ?? "",
      criteria: goal?.criteria ?? [],
      currentTodo: current ? current.content : "",
      nextAction: current
        ? `Work on todo ${current.id}: ${current.content}`
        : (goal?.statement ?? ""),
    };
  }

  /** Recent files from tool calls, retained alongside the goal on compaction. */
  private activeFiles(session: unknown): string | null {
    const messages = (session as { messages?: Message[] })?.messages;
    if (!Array.isArray(messages)) return null;
    const files: string[] = [];
    for (let i = messages.length - 1; i >= 0 && files.length < 10; i--) {
      const toolCalls = (messages[i] as any)?.toolCalls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        if (!["read", "write", "edit"].includes(String(call?.name ?? ""))) {
          continue;
        }
        const filePath = (call as any)?.arguments?.path;
        if (
          typeof filePath === "string" &&
          filePath &&
          !files.includes(filePath)
        ) {
          files.push(filePath);
        }
        if (files.length >= 10) break;
      }
    }
    return files.length ? files.map((file) => `- ${file}`).join("\n") : null;
  }

  /** Supply the goal/ledger state used by both the build and the summarizer. */
  private syncStaticContext(
    completionCheck: boolean,
    files: string | null,
  ): void {
    this.contextManager.setStaticContext({
      goal: this.goalStore.renderForPrompt(),
      ledger: this.todoStore.renderForPrompt({ completionCheck }),
      files,
      continuation: this.continuationInput(),
    });
  }

  /** Mirror the one-shot continuation into the transcript and session log. */
  private mirrorContinuation(
    text: string | null,
    session?: {
      appendMessage(m: Message): void;
      appendEvent?(partial: any): any;
    },
  ): void {
    if (!text) return;
    if (session) {
      session.appendMessage({ role: "system", content: text });
      if (typeof session.appendEvent === "function") {
        session.appendEvent({
          type: "context_compacted_continuation",
          text,
        });
      }
    }
    this.onEvent?.({ type: "compaction_continuation", text });
  }

  /** Persist instruction baseline state; a failed write fails the turn. */
  private persistInstructionBaseline(
    state: InstructionBaselineState,
    session: {
      events?: unknown[];
      appendEvent?(partial: any): any;
    },
  ): void {
    if (typeof session.appendEvent !== "function") return;
    try {
      session.appendEvent({ type: "instruction_baseline", ...state });
    } catch (error) {
      throw new Error("INSTRUCTION_BASELINE_WRITE_FAILED", { cause: error });
    }
  }

  /** Freeze the first instruction set, record later changes, and render state. */
  private syncInstructionBaseline(session: {
    events?: unknown[];
    appendEvent?(partial: any): any;
  }): InstructionBaselineState {
    const texts = this.contextManager.getInstructionTexts(this.workspace);
    const seq = (session.events?.length ?? 0) + 1;
    const stored = latestEvent(session, "instruction_baseline");
    let state: InstructionBaselineState;
    if (
      stored?.schemaVersion === 1 &&
      Array.isArray(stored.baseline) &&
      Array.isArray(stored.updates)
    ) {
      state = stored as unknown as InstructionBaselineState;
    } else {
      state = initialBaseline(texts, seq);
      this.persistInstructionBaseline(state, session);
    }
    const next = recordInstructionChange(state, texts, seq);
    if (next !== state) {
      state = next;
      this.persistInstructionBaseline(state, session);
    }
    this.contextManager.setInstructionState(state);
    return state;
  }

  async runAgentTurn(
    input: string,
    session: {
      id?: string;
      messages: Message[];
      events?: unknown[];
      appendMessage(m: Message): void;
      appendEvent?(partial: any): any;
    },
    signal: AbortSignal,
    options?: { requestId?: string },
  ): Promise<string> {
    // Restore any persisted session memory for resumed sessions.
    const latest = latestEvent(session, "context_compacted");
    const summary = typeof latest?.summary === "string" ? latest.summary : null;
    const restoredCheckpoint =
      summary && latest?.schemaVersion === 1
        ? (latest as unknown as import("../context/manager.js").MemoryCheckpoint)
        : null;
    this.contextManager.setSessionMemory(
      summary,
      typeof latest?.coveredCount === "number"
        ? latest.coveredCount
        : undefined,
      restoredCheckpoint,
    );
    this.restoreTodos(session);
    this.restoreGoal(session);
    let instructionState = this.syncInstructionBaseline(session);

    this.turnIndex += 1;
    // Resolve a per-turn correlation id once and reuse it for every model
    // call in the turn. Persisting it makes the request traceable after the
    // fact (session log + event consumers).
    const requestId = (options?.requestId ?? "").trim() || randomUUID();
    // The compaction summarizer issues its own model call; give it the same
    // correlation ids so it produces a ledger record too.
    this.contextManager.setUsageContext?.(session.id ?? "", requestId);
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

    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: input }],
    });

    await this.extensionDispatch?.("turn_start", { type: "turn_start" });
    let completionNudges = 0;
    const maxCompletionNudges = 3;
    try {
      while (true) {
        // Pause is a goal status enforced between iterations. In-flight tool
        // calls and the current iteration have already finished by this point.
        if (this.goalStore.status === "paused") {
          this.onEvent?.({ type: "goal_state", goal: this.goalStore.get() });
          await this.extensionDispatch?.("agent_settled", {
            type: "agent_settled",
          });
          return "GOAL_PAUSED";
        }

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

        instructionState = this.syncInstructionBaseline(session);
        this.syncStaticContext(
          completionNudges > 0 && this.todoStore.openCount() > 0,
          this.activeFiles(session),
        );
        const messages = await this.contextManager.build(
          this.workspace,
          session.messages,
        );
        await this.extensionDispatch?.("context_build", {
          type: "context_build",
          messages,
        });
        const failure = this.contextManager.consumeCompactionFailure();
        if (failure) {
          this.onEvent?.({
            type: "context_compaction_failed",
            model: this.model,
            strategy: "summary",
            reason: failure,
          });
        }
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
          const checkpoint = this.contextManager.consumeCompactionCheckpoint();
          if (summary && typeof (session as any).appendEvent === "function") {
            (session as any).appendEvent({
              type: "context_compacted",
              ...(checkpoint ?? {
                schemaVersion: 1,
                summary,
                coveredCount,
                coveredTokens: 0,
                keptCount: 0,
                model: this.model,
                strategy: "summary",
              }),
            });
          }
          const folded = foldInstructionBaseline(
            instructionState,
            this.contextManager.getInstructionTexts(this.workspace),
            (session.events?.length ?? 0) + 1,
          );
          this.persistInstructionBaseline(folded, session);
          this.contextManager.setInstructionState(folded);
          instructionState = folded;
          this.mirrorContinuation(
            this.contextManager.consumeCompactionContinuation(),
            session,
          );
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
          usageLedger: this.usageLedger,
          sessionId: session.id,
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

        // Tool callbacks are synchronous: collect their dispatch promises here
        // and await them after the batch so no update handler outlives the turn.
        const pendingUpdates: Promise<unknown>[] = [];
        const ctx = {
          workspace: this.workspace,
          mode: this.mode,
          web: this.web,
          supportsVision: this.supportsVision,
          backgroundTasks: this.backgroundTasks,
          todos: this.todoStore,
          goal: this.goalStore,
          signal,
          maxBashTimeMs: this.limits.maxBashTimeMs,
          maxToolOutputBytes: this.limits.maxToolOutputBytes,
          onReadPath: (readPath: string) => this.noteReadPath(readPath),
          approvals: this.approvals,
          questions: this.questions,
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
            pendingUpdates.push(
              Promise.resolve().then(() =>
                this.extensionDispatch?.("tool_execution_update", {
                  type: "tool_execution_update",
                  toolCallId: call.id,
                  name: call.name,
                  stream,
                  text,
                }),
              ),
            );
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

        const execCalls = toolCalls.filter((c: any) => !blocked.has(c.id));
        for (const call of execCalls) {
          const pathArg = (call as any)?.arguments?.path;
          if (typeof pathArg === "string") {
            void touchLspFile(path.resolve(this.workspace, pathArg)).catch(
              () => {},
            );
          }
        }
        const goalStatusBeforeTools = this.goalStore.status;
        const execResults = await executeToolBatch(
          execCalls,
          wrappedToolMap,
          ctx,
          this.limits.maxParallelToolCalls,
          signal,
          undefined,
          this.bashConcurrency,
        );
        await Promise.all(pendingUpdates);

        if (
          execResults.some((result: any) => result?.name === "todo") &&
          this.toolMap.has("todo")
        ) {
          this.todoTouchedThisTurn = true;
          this.persistTodos(session);
          this.emitLedgerState();
        }
        if (goalStatusBeforeTools !== this.goalStore.status) {
          this.persistGoal(session);
          this.emitGoalState();
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

        // A dismissed question is not model-facing output. OpenCode records
        // the tool call as aborted and ends the step; do the same so the model
        // never treats a dismissal as an answer.
        if (
          !signal.aborted &&
          orderedResults.some(
            (r: any) => r?.details?.questionDismissed === true,
          )
        ) {
          await this.extensionDispatch?.("agent_settled", {
            type: "agent_settled",
          });
          return text;
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
