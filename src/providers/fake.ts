import type {
  FinishReason,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  TokenUsage,
  ToolCall,
} from "../types.js";
import type { ProviderAdapter } from "./types.js";

export interface FakeResponse {
  text?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
}

export interface FakeProviderOptions {
  /** When true, the provider exposes a deterministic streaming method. */
  stream?: boolean;
  /** Characters per streamed text chunk. Defaults to 8. */
  chunkSize?: number;
  /** Delay before the first streamed chunk, in milliseconds. */
  firstTokenDelayMs?: number;
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
  /** Throw instead of returning an empty response when the script is used up. */
  strict?: boolean;
  /** Answer a request without consuming the scripted response list. */
  respond?: (request: ModelRequest) => FakeResponse | undefined;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  stream?: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;
  private responses: FakeResponse[];
  private index = 0;
  private options: FakeProviderOptions;
  private requestCount = 0;

  constructor(responses: FakeResponse[], options: FakeProviderOptions = {}) {
    this.responses = responses;
    this.options = options;
    if (options.stream) {
      this.stream = (request) => this.streamResponses(request);
    }
  }

  /** Number of provider calls made, including summarizer calls. */
  get calls(): number {
    return this.requestCount;
  }

  /** Scripted responses not yet consumed. */
  get remaining(): number {
    return this.responses.length - this.index;
  }

  private next(request: ModelRequest): FakeResponse {
    this.requestCount += 1;
    const custom = this.options.respond?.(request);
    if (custom) return custom;
    if (this.index >= this.responses.length) {
      if (this.options.strict) {
        throw new Error("FakeProvider script exhausted");
      }
      return { text: "" };
    }
    return this.responses[this.index++];
  }

  private toResponse(r: FakeResponse): ModelResponse {
    const toolCalls = r.toolCalls ?? [];
    return {
      message: {
        role: "assistant",
        content: r.text ? [{ type: "text", text: r.text }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason:
        r.finishReason ?? (toolCalls.length ? "tool_calls" : "stop"),
      usage: r.usage,
      metadata: r.thinking ? { thinking: r.thinking } : undefined,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return this.toResponse(this.next(request));
  }

  private async *streamResponses(
    request: ModelRequest,
  ): AsyncIterable<ModelStreamEvent> {
    const r = this.next(request);
    await wait(this.options.firstTokenDelayMs ?? 0);
    if (r.thinking) {
      yield { type: "thinking", text: r.thinking };
      await wait(this.options.chunkDelayMs ?? 0);
    }
    for (const toolCall of r.toolCalls ?? []) {
      yield { type: "tool_call", toolCall };
      await wait(this.options.chunkDelayMs ?? 0);
    }
    const text = r.text ?? "";
    const chunkSize = Math.max(1, this.options.chunkSize ?? 8);
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: "text", text: text.slice(i, i + chunkSize) };
      await wait(this.options.chunkDelayMs ?? 0);
    }
    yield { type: "done", response: this.toResponse(r) };
  }
}
