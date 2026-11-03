import type { AgentRuntimeOptions } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest, AgentLimits } from "../types.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private workspace: string;
  private tools: AgentRuntimeOptions["tools"];
  private toolMap: Map<string, AgentRuntimeOptions["tools"][number]>;
  private limits: AgentLimits;
  private systemPrompt: string;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "default";
    this.workspace = options.workspace ?? process.cwd();
    this.tools = options.tools;
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

      const messages: Message[] = [
        { role: "system", content: this.systemPrompt },
        ...session.messages,
      ];

      const request: ModelRequest = {
        model: this.model,
        messages,
        tools: this.tools.map((t) => t.definition),
        signal,
      };

      const response = await this.provider.generate(request);
      session.append(response.message);

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        const text =
          response.message.content
            ?.map((p) => (p.type === "text" ? p.text : ""))
            .join("") ?? "";
        return text;
      }

      totalToolCalls += toolCalls.length;
      if (totalToolCalls > this.limits.maxToolCalls) {
        return "TASK_BUDGET_REACHED";
      }

      // Execute tool calls sequentially (parallel scheduling lands in ticket 03).
      for (const call of toolCalls) {
        const tool = this.toolMap.get(call.name);
        let resultContent: string;
        let isError = false;
        if (!tool) {
          resultContent = `TOOL_NOT_FOUND: ${call.name}`;
          isError = true;
        } else {
          try {
            const r = await tool.execute(call, {
              workspace: this.workspace,
              signal,
              maxBashTimeMs: this.limits.maxBashTimeMs,
              maxToolOutputBytes: this.limits.maxToolOutputBytes,
            });
            // workspace is injected by caller; set below via context. For now use process cwd.
            resultContent = r.content;
            isError = !!r.isError;
          } catch (err) {
            resultContent = `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        }
        session.append({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: resultContent,
        });
        if (isError) {
          // still continue; error is part of transcript
        }
      }
    }

    return "TASK_BUDGET_REACHED";
  }
}
