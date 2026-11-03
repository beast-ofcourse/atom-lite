import type { AgentRuntimeOptions } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest, AgentLimits } from "../types.js";
import { executeToolBatch } from "../runtime/scheduler.js";
import { ContextManager } from "../context/manager.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private workspace: string;
  private approvals: AgentRuntimeOptions["approvals"];
  private contextManager: ContextManager;
  private onEvent: AgentRuntimeOptions["onEvent"];
  private tools: AgentRuntimeOptions["tools"];
  private toolMap: Map<string, AgentRuntimeOptions["tools"][number]>;
  private limits: AgentLimits;
  private systemPrompt: string;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "default";
    this.workspace = options.workspace ?? process.cwd();
    this.approvals = options.approvals;
    this.onEvent = options.onEvent;
    this.tools = options.tools;
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
    this.systemPrompt = options.systemPrompt ?? "You are a coding assistant.";
  }

  async runAgentTurn(
    input: string,
    session: { messages: Message[]; append(m: Message): void },
    signal: AbortSignal,
  ): Promise<string> {
    session.append({ role: "user", content: [{ type: "text", text: input }] });

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

      const request: ModelRequest = {
        model: this.model,
        messages,
        tools: this.tools.map((t) => t.definition),
        signal,
      };

      const response = await this.provider.generate(request);
      session.append(response.message);

      const text =
        response.message.content
          ?.map((p) => (p.type === "text" ? p.text : ""))
          .join("") ?? "";
      if (text) this.onEvent?.({ type: "assistant_text", text });

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        this.onEvent?.({ type: "final", text });
        return text;
      }
      for (const c of toolCalls)
        this.onEvent?.({ type: "tool_call", name: c.name, args: c.arguments });

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
      };
      const results = await executeToolBatch(
        toolCalls,
        this.toolMap,
        ctx,
        this.limits.maxParallelToolCalls,
        signal,
      );
      for (const r of results) {
        session.append({
          role: "tool",
          toolCallId: r.toolCallId,
          name: r.name,
          content: r.content,
        });
        this.onEvent?.({ type: "tool_result", name: r.name, content: r.content, isError: r.isError });
      }
    }

    return "TASK_BUDGET_REACHED";
  }
}
