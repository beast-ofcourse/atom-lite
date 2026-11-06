import type { AgentRuntimeOptions, ContextUsage } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest, AgentLimits } from "../types.js";
import { executeToolBatch } from "../runtime/scheduler.js";
import { ContextManager } from "../context/manager.js";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js";
import { BackgroundTaskManager } from "../runtime/background-tasks.js";
import { CheckpointStore } from "../runtime/checkpoint-store.js";
import { runModelTurn } from "./model-turn.js";
import { TurnRecorder } from "./turn-recorder.js";

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
  private onEvent: AgentRuntimeOptions["onEvent"];
  private tools: AgentRuntimeOptions["tools"];
  private effort: string;
  private bashConcurrency: "serial" | "parallel";
  private toolMap: Map<string, AgentRuntimeOptions["tools"][number]>;
  private limits: AgentLimits;
  private extensionDispatch: AgentRuntimeOptions["extensionDispatch"];
  private steeringQueue: string[] | undefined;
  private systemPrompt: string;
  private contextWindow: number | undefined;
  private contextUsed: number | undefined;
  private supportsVision: boolean | undefined;
  private backgroundTasks: BackgroundTaskManager;
  private checkpointingEnabled: boolean;
  private checkpointStoreOverride: CheckpointStore | undefined;
  private turnCheckpointed = false;
  private turnCheckpointId: string | null = null;
  private turnCheckpointStore: CheckpointStore | null = null;
  private turnIndex = 0;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "default";
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
        model: options.model ?? "default",
      });
    this.toolMap = new Map(options.tools.map((t) => [t.definition.name, t]));
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.extensionDispatch = options.extensionDispatch;
    this.steeringQueue = options.steeringQueue;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.contextWindow = options.contextWindow;
    this.supportsVision = options.supportsVision;
    this.backgroundTasks = options.backgroundTasks ?? new BackgroundTaskManager();
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
    this.onEvent?.({ type: "model_switched", provider: provider.id, model: this.model });
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

  private injectCompletedBackgroundTasks(session: { appendMessage(m: any): void }): void {
    for (const t of this.backgroundTasks.drainCompleted()) {
      session.appendMessage({
        role: "system",
        content: `[background task ${t.id} ${t.status}] ${t.output}`,
      });
      this.onEvent?.({ type: "background_task_complete", id: t.id, status: t.status, exitCode: t.exitCode });
    }
  }

  getContextUsage(): ContextUsage {
    return { used: this.contextUsed, window: this.contextWindow };
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

  setSteeringQueue(queue: string[]): void {
    this.steeringQueue = queue;
  }

  async compactSession(
    session: { messages: Message[]; appendMessage(m: Message): void; appendEvent?(partial: any): any },
    focus?: string,
  ): Promise<string | null> {
    const summary = await this.contextManager.compactHistory(
      this.workspace,
      session.messages,
      focus,
    );
    if (summary) {
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
  }

  getEffort(): string {
    return this.effort;
  }

  async runAgentTurn(
    input: string,
    session: { messages: Message[]; appendMessage(m: Message): void; appendEvent?(partial: any): any },
    signal: AbortSignal,
  ): Promise<string> {
    // Restore any persisted session memory for resumed sessions.
    const events = (session as any).events;
    if (Array.isArray(events)) {
      const latest = [...events].reverse().find((e: any) => e?.type === "context_compacted");
      this.contextManager.setSessionMemory(
        typeof latest?.summary === "string" ? latest.summary : null,
        typeof latest?.coveredCount === "number" ? latest.coveredCount : undefined,
      );
    }

    this.turnIndex += 1;
    this.injectCompletedBackgroundTasks(session);
    this.turnCheckpointed = false;
    this.turnCheckpointId = null;
    this.turnCheckpointStore = null;

    session.appendMessage({ role: "user", content: [{ type: "text", text: input }] });

    await this.extensionDispatch?.("turn_start", { type: "turn_start" });
    let forceContinue = false;
    const start = Date.now();

    while (true) {
      forceContinue = false;
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
      await this.extensionDispatch?.("context_build", {
        type: "context_build",
        messages,
      });
      if (this.contextManager.consumeCompaction()) {
        // Peers treat usage as unknown after compaction until the next
        // assistant response reports fresh numbers.
        this.contextUsed = undefined;
        this.emitContextUsage();
        const summary = this.contextManager.consumeCompactionSummary();
        const coveredCount = this.contextManager.consumeCompactionCoveredCount();
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
        signal,
      })) {
        if (ev.type === "thinking_delta") {
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
          forceContinue = true;
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
          forceContinue = true;
          continue;
        }
        // Discard a checkpoint that produced no changes.
        if (this.turnCheckpointId && this.turnCheckpointStore) {
          try {
            if (this.turnCheckpointStore.isAtCheckpoint(this.turnCheckpointId)) {
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
        signal,
        maxBashTimeMs: this.limits.maxBashTimeMs,
        maxToolOutputBytes: this.limits.maxToolOutputBytes,
        approvals: this.approvals,
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
      const readOnly = new Set(["read", "grep", "glob", "webfetch", "websearch", "task"]);
      const hasMutating = toolCalls.some((c: any) => !blocked.has(c.id) && !readOnly.has(c.name));
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
              const m = store.create(this.turnIndex, `turn ${this.turnIndex}`);
              this.turnCheckpointId = m.id;
              try {
                if (typeof (session as any).appendEvent === "function") {
                  (session as any).appendEvent({
                    type: "checkpoint_created",
                    checkpointId: m.id,
                    turn: this.turnIndex,
                    fileCount: m.files.length,
                    bytes: m.bytes,
                  });
                }
              } catch {
                // best effort
              }
              this.onEvent?.({ type: "checkpoint_created", id: m.id });
            } catch (err) {
              this.onEvent?.({
                type: "checkpoint_failed",
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            this.onEvent?.({ type: "checkpoint_unavailable", reason: avail.reason });
          }
        }
      }

      const execCalls = toolCalls.filter((c: any) => !blocked.has(c.id));
      const execResults = await executeToolBatch(
        execCalls,
        wrappedToolMap,
        ctx,
        this.limits.maxParallelToolCalls,
        signal,
        undefined,
        this.bashConcurrency,
      );

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
        r.structuredContent = payload.structuredContent ?? r.structuredContent;
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
            if (this.turnCheckpointStore.isAtCheckpoint(this.turnCheckpointId)) {
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

    return "TASK_BUDGET_REACHED";
  }
}
