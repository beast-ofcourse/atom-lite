import type { Message, ModelRequest } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";

export interface ModelTurnRequest {
  provider: ProviderAdapter;
  model: string;
  messages: Message[];
  tools: ModelRequest["tools"];
  effort: string;
  signal: AbortSignal;
}

export type ModelTurnEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "final";
      response: {
        message: Message;
        toolCalls?: ModelRequest extends { tools: infer T } ? unknown : unknown;
        usage?: { input?: number; output?: number };
      };
      streamedText: string;
    };

export class ModelTurn {
  static run(request: ModelTurnRequest) {
    return runModelTurn(request);
  }
}

export async function* runModelTurn(
  request: ModelTurnRequest,
): AsyncGenerator<ModelTurnEvent> {
  const modelRequest: ModelRequest = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    signal: request.signal,
    options: { effort: request.effort },
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
  yield { type: "final", response, streamedText: text };
}
