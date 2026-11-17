import type { Message, ModelRequest, ToolCall } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import { recordModelUsage, type UsageLedger } from "../usage/ledger.js";

export interface ModelTurnRequest {
  provider: ProviderAdapter;
  model: string;
  messages: Message[];
  tools: ModelRequest["tools"];
  effort: string;
  temperature?: number;
  signal: AbortSignal;
  /** Optional caller-supplied id for the outgoing model request. */
  requestId?: string;
  /** Optional per-call usage ledger. Inert when absent. */
  usageLedger?: UsageLedger;
  /** Session id recorded alongside the call, when known. */
  sessionId?: string;
}

export type ModelTurnEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "final";
      response: {
        message: Message;
        toolCalls?: ToolCall[];
        usage?: { input?: number; output?: number; total?: number };
        requestId?: string;
      };
      streamedText: string;
    };

export async function* runModelTurn(
  request: ModelTurnRequest,
): AsyncGenerator<ModelTurnEvent> {
  const recordUsage = (
    response: {
      usage?: { input?: number; output?: number; total?: number };
      requestId?: string;
    },
  ): void => {
    recordModelUsage(
      request.usageLedger,
      {
        sessionId: request.sessionId ?? "",
        requestId: response.requestId ?? request.requestId ?? "",
        provider: request.provider.id,
        model:
          request.model && request.model !== "default"
            ? request.model
            : (request.provider.model ?? "default"),
      },
      response.usage,
    );
  };

  const options: Record<string, unknown> = { effort: request.effort };
  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }
  const modelRequest: ModelRequest = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    signal: request.signal,
    options,
    requestId: request.requestId,
  };

  if (typeof request.provider.stream === "function") {
    let response: any;
    let streamedText = "";
    for await (const ev of request.provider.stream(modelRequest)) {
      if (ev.type === "thinking") {
        yield { type: "thinking_delta", text: ev.text };
      } else if (ev.type === "text") {
        streamedText += ev.text;
        yield { type: "assistant_delta", text: ev.text };
      } else if (ev.type === "done") {
        response = ev.response;
      }
    }
    if (!response) {
      response = {
        message: {
          role: "assistant",
          content: streamedText
            ? [{ type: "text", text: streamedText }]
            : undefined,
        },
        toolCalls: [],
        finishReason: "stop",
      };
    }
    recordUsage(response);
    yield { type: "final", response, streamedText };
    return;
  }

  const response = await request.provider.generate(modelRequest);
  const text =
    response.message.content
      ?.map((p: any) => (p.type === "text" ? p.text : ""))
      .join("") ?? "";
  if (text) {
    yield { type: "assistant_text", text };
  }
  recordUsage(response);
  yield { type: "final", response, streamedText: text };
}
