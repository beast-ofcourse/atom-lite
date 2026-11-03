import type { ModelRequest, ModelResponse, ToolCall } from "../types.js";
import type { ProviderAdapter } from "./types.js";

export interface FakeResponse {
  text?: string;
  toolCalls?: ToolCall[];
}

export class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  private responses: FakeResponse[];
  private index = 0;

  constructor(responses: FakeResponse[]) {
    this.responses = responses;
  }

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    const r = this.responses[this.index++] ?? { text: "" };
    const toolCalls = r.toolCalls ?? [];
    return {
      message: {
        role: "assistant",
        content: r.text ? [{ type: "text", text: r.text }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
    };
  }
}
