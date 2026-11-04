import type { Message } from "../types.js";

export interface TurnRecorderOptions {
  session: { appendMessage(message: Message): void };
  onEvent?: (event: unknown) => void;
}

export class TurnRecorder {
  private session: TurnRecorderOptions["session"];
  private onEvent: TurnRecorderOptions["onEvent"];

  constructor(options: TurnRecorderOptions) {
    this.session = options.session;
    this.onEvent = options.onEvent;
  }

  recordAssistant(response: {
    message: Message;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    usage?: { input?: number; output?: number };
  }, streamedText: string): string {
    this.session.appendMessage(response.message);
    const text =
      streamedText ||
      (Array.isArray(response.message.content)
        ? response.message.content
            .map((p: any) => (p?.type === "text" ? p.text : ""))
            .join("")
        : typeof response.message.content === "string"
          ? response.message.content
          : "");
    if (response.usage) {
      const used = (response.usage.input ?? 0) + (response.usage.output ?? 0);
      if (used > 0) {
        this.onEvent?.({ type: "usage", input: response.usage.input, output: response.usage.output });
      }
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      this.onEvent?.({ type: "final", text });
    } else {
      for (const call of toolCalls) {
        this.onEvent?.({
          type: "tool_call",
          id: call.id,
          name: call.name,
          args: call.arguments,
        });
      }
    }
    return text;
  }

  recordToolResult(result: {
    toolCallId: string;
    name: string;
    content: string;
    isError?: boolean;
    diff?: string[];
  }): void {
    this.session.appendMessage({
      role: "tool",
      toolCallId: result.toolCallId,
      name: result.name,
      content: result.content,
    });
    this.onEvent?.({
      type: "tool_result",
      toolCallId: result.toolCallId,
      name: result.name,
      content: result.content,
      isError: result.isError,
      diff: result.diff,
    });
  }
}
