import type { AgentRuntimeOptions } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest, AgentLimits } from "../types.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private model: string;
  private tools: AgentRuntimeOptions["tools"];
  private limits: AgentLimits;
  private systemPrompt: string;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "default";
    this.tools = options.tools;
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
        tools: this.tools,
        signal,
      };

      const response = await this.provider.generate(request);
      session.append(response.message);

      if (response.toolCalls.length === 0) {
        const text =
          response.message.content
            ?.map((p) => (p.type === "text" ? p.text : ""))
            .join("") ?? "";
        return text;
      }

      totalToolCalls += response.toolCalls.length;
      if (totalToolCalls > this.limits.maxToolCalls) {
        return "TASK_BUDGET_REACHED";
      }

      // Tool execution is implemented in later tickets; record placeholders.
      for (const call of response.toolCalls) {
        session.append({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Tool ${call.name} not implemented in skeleton`,
        });
      }
    }

    return "TASK_BUDGET_REACHED";
  }
}
