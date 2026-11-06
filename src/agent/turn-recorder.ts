import type { Message } from "../types.js";

export interface TurnRecorderOptions {
  session: { appendMessage(message: Message): void };
  onEvent?: (event: unknown) => void;
  extensionDispatch?: (event: string, payload: any) => Promise<any[]> | any[];
}

export class TurnRecorder {
  private session: TurnRecorderOptions["session"];
  private onEvent: TurnRecorderOptions["onEvent"];
  private extensionDispatch: TurnRecorderOptions["extensionDispatch"];

  constructor(options: TurnRecorderOptions) {
    this.session = options.session;
    this.onEvent = options.onEvent;
    this.extensionDispatch = options.extensionDispatch;
  }

  async recordAssistant(
    response: {
      message: Message;
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
      usage?: { input?: number; output?: number };
    },
    streamedText: string,
  ): Promise<string> {
    let message: Message = response.message;
    void this.extensionDispatch?.("message_start", {
      type: "message_start",
      message,
    });
    const results = await this.extensionDispatch?.("message_end", {
      type: "message_end",
      message,
    });
    const replacement = Array.isArray(results)
      ? results.find((x: any) => x && x.message)?.message
      : (results as any)?.message;
    if (
      replacement &&
      typeof replacement === "object" &&
      (replacement as any).role === message.role
    ) {
      message = replacement as Message;
    }
    this.session.appendMessage(message);
    const text =
      streamedText ||
      (Array.isArray(message.content)
        ? message.content
            .map((p: any) => (p?.type === "text" ? p.text : ""))
            .join("")
        : typeof message.content === "string"
          ? message.content
          : "");
    if (response.usage) {
      this.onEvent?.({
        type: "usage",
        input: response.usage.input,
        output: response.usage.output,
      });
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
    images?: Array<{ data: string; mime: string }>;
  }): void {
    this.session.appendMessage({
      role: "tool",
      toolCallId: result.toolCallId,
      name: result.name,
      content: result.content,
      images: result.images,
      isError: result.isError,
      diff: Array.isArray(result.diff) ? result.diff : undefined,
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
