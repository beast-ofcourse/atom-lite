import type { AgentLimits, AgentRuntimeOptions } from "./types.js";
import { DEFAULT_LIMITS } from "../types.js";
import type { Message, ModelRequest } from "../types.js";

export class AgentRuntime {
  private provider: AgentRuntimeOptions["provider"];
  private tools: AgentRuntimeOptions["tools"];
  private limits: AgentLimits;
  private systemPrompt: string;

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.systemPrompt = options.systemPrompt ?? "You are a coding assistant.";
  }

  async runTurn(
    input: string,
    session: { messages: Message[]; append(m: Message): void },
    signal: AbortSignal,
  ): Promise<string> {
    session.append({ role: "user", content: [{ type: "text", text: input }] });

    for (let iteration = 0; iteration < this.limits.maxIterations; iteration++) {
      if (signal.aborted) {
        throw new Error("USER_CANCELLED");
      }

      const messages: Message[] = [
        { role: "system", content: this.systemPrompt },
        ...session.messages,
      ];

      const request: ModelRequest = {
        model: "fake",
        messages,
        tools: this.tools,
        signal,
      };

      const response = await this.provider.generate(request);
      session.append(response.message);

      if (response.toolCalls.length === 0) {
        const text = response.message.content
          ?.map((p) => (p.type === "text" ? p.text : ""))
          .join("") ?? "";
        return text;
      }

      // Tools are not implemented in this skeleton; record the calls as
      // an assistant turn only. Real execution lands in ticket 02.
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