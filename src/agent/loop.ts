import type { AgentRuntimeOptions, ContextUsage } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest, AgentLimits } from "../types.js";
import { executeToolBatch } from "../runtime/scheduler.js";
import { ContextManager } from "../context/manager.js";
import { runModelTurn } from "./model-turn.js";
import { TurnRecorder } from "./turn-recorder.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private workspace: string;
  private approvals: AgentRuntimeOptions["approvals"];
  private contextManager: ContextManager;
  private onEvent: AgentRuntimeOptions["onEvent"];
  private tools: AgentRuntimeOptions["tools"];
  private effort: string;
  private bashConcurrency: "serial" | "parallel";
  private toolMap: Map<string, AgentRuntimeOptions["tools"][number]>;
  private limits: AgentLimits;
  private systemPrompt: string;
  private contextWindow: number | undefined;
  private contextUsed: number | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "default";
    this.workspace = options.workspace ?? process.cwd();
    this.approvals = options.approvals;
    this.onEvent = options.onEvent;
    this.tools = options.tools;
    this.effort = options.effort ?? "medium";
    this.bashConcurrency = options.bashConcurrency ?? "serial";
    this.contextManager =
      options.contextManager ??
      new ContextManager({
        systemPrompt: options.systemPrompt ?? "You are a coding assistant.",
        maxInputTokens: null,
        reserveOutputTokens: 4096,
        compactAtPercent: 85,
        maxProjectInstructionBytes: 30000,
        provider: options.provider,
        model: options.model ?? "default",
      });
    this.toolMap = new Map(options.tools.map((t) => [t.definition.name, t]));
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.systemPrompt = options.systemPrompt ?? "You are a coding assistant with tools: read, write, edit, bash, webfetch, websearch.";
    this.contextWindow = options.contextWindow;
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

    session.appendMessage({ role: "user", content: [{ type: "text", text: input }] });

    let totalToolCalls = 0;
    const start = Date.now();

    for (
      let iteration = 0;
      iteration < this.limits.maxIterations;
      iteration++
    ) {
      if (signal.aborted) {
        throw new Error("USER_CANCELLED");
      }
      if (Date.now() - start > this.limits.maxExecutionMs) {
        return "TASK_BUDGET_REACHED";
      }

      const messages = await this.contextManager.build(
        this.workspace,
        session.messages,
      );
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

      const recorder = new TurnRecorder({
        session,
        onEvent: this.onEvent as ((event: unknown) => void) | undefined,
      });
      const text = recorder.recordAssistant(response, streamedText);

      if (response.usage) {
        const used =
          (response.usage.input ?? 0) + (response.usage.output ?? 0);
        if (used > 0) {
          // The latest assistant step's prompt + generated tokens is the
          // current context occupancy (not a cumulative session total).
          this.contextUsed = used;
          this.emitContextUsage();
        }
      }

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return text;
      }

      totalToolCalls += toolCalls.length;
      if (totalToolCalls > this.limits.maxToolCalls) {
        return "TASK_BUDGET_REACHED";
      }

      const ctx = {
        workspace: this.workspace,
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
        },
      };
      const results = await executeToolBatch(
        toolCalls,
        this.toolMap,
        ctx,
        this.limits.maxParallelToolCalls,
        signal,
        undefined,
        this.bashConcurrency,
      );
      for (const r of results) {
        recorder.recordToolResult(r);
      }
    }

    return "TASK_BUDGET_REACHED";
  }
}
