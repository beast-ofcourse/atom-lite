import type { Message, ModelRequest, ToolCall, TokenUsage } from "../types.js";
import type { ProviderAdapter } from "../providers/types.js";
import { recordModelUsage, type UsageLedger } from "../usage/ledger.js";
import { attributeMessages } from "../context/attribution.js";

export interface ModelTurnRequest {
  provider: ProviderAdapter;
  model: string;
  messages: Message[];
  tools: ModelRequest["tools"];
  effort: string;
  reasoning?: string;
  temperature?: number;
  signal: AbortSignal;
  /** Optional caller-supplied id for the outgoing model request. */
  requestId?: string;
  /** Optional per-call usage ledger. Inert when absent. */
  usageLedger?: UsageLedger;
  /** Session id recorded alongside the call, when known. */
  sessionId?: string;
  /** Reports time spent serializing each provider request body. */
  onSerialized?: (elapsedMs: number) => void;
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
        usage?: TokenUsage;
        requestId?: string;
      };
      streamedText: string;
    };

export async function* runModelTurn(
  request: ModelTurnRequest,
): AsyncGenerator<ModelTurnEvent> {
  const recordUsage = (response: {
    usage?: TokenUsage;
    requestId?: string;
  }): void => {
    const { attribution, compacted, prefix } = attributeMessages(
      request.messages,
      request.sessionId,
    );
    recordModelUsage(
      request.usageLedger,
      {
        attribution,
        compacted,
        prefix,
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
  if (request.reasoning !== undefined) options.reasoning = request.reasoning;
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
    onSerialized: request.onSerialized,
  };

  if (typeof request.provider.stream === "function") {
    const startedAt = Date.now();
    let thinkingStartedAt: number | undefined;
    let thinkingEndedAt: number | undefined;
    let response: any;
    let streamedText = "";
    for await (const ev of request.provider.stream(modelRequest)) {
      if (ev.type === "thinking") {
        if (thinkingStartedAt === undefined) thinkingStartedAt = Date.now();
        yield { type: "thinking_delta", text: ev.text };
      } else if (ev.type === "text") {
        if (thinkingStartedAt !== undefined && thinkingEndedAt === undefined) {
          thinkingEndedAt = Date.now();
        }
        streamedText += ev.text;
        yield { type: "assistant_delta", text: ev.text };
      } else if (ev.type === "done") {
        response = ev.response;
      }
    }
    if (thinkingStartedAt !== undefined && thinkingEndedAt === undefined) {
      thinkingEndedAt = Date.now();
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
    response.elapsedMs = Date.now() - startedAt;
    if (thinkingStartedAt !== undefined && thinkingEndedAt !== undefined) {
      const ms = thinkingEndedAt - thinkingStartedAt;
      if (ms > 0) response.thinkingMs = ms;
    }
    recordUsage(response);
    yield { type: "final", response, streamedText };
    return;
  }

  const startedAt = Date.now();
  const response = await request.provider.generate(modelRequest);
  response.elapsedMs = Date.now() - startedAt;
  // Non-streaming: no per-phase timing available; leave thinkingMs unset
  // unless the provider reported a thinking duration in metadata.
  if (
    response.thinkingMs === undefined &&
    typeof (response as any)?.metadata?.thinkingMs === "number"
  ) {
    response.thinkingMs = (response as any).metadata.thinkingMs;
  }
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
