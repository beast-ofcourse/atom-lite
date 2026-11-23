import type {
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
  TokenUsage,
} from "../types.js";
import type { ProviderAdapter } from "./types.js";
import {
  contextWindowFromModelEntry,
  supportsVisionFromModelEntry,
  knownVisionModel,
  knownContextWindow,
} from "./context-window.js";
import { isRetryableStatus, retryDelayMs, delay } from "./retry.js";
import { resolveFinishReason } from "./finish-reason.js";
import {
  parseArgs,
  assembleToolCalls,
  toToolCalls,
  type RawToolCallChunk,
} from "./tool-calls.js";
import {
  applyRequestId,
  mergeHeaders,
  resolveRequestId,
  setHeader,
} from "./http-headers.js";
import { parseOpenAIUsage } from "./usage.js";

function resolveReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value === "off") return "none";
  if (value === "max") return "xhigh";
  return value;
}

export interface OpenAICompatibleConfig {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  contextWindow?: number;
  supportsVision?: boolean;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  public model: string;
  private baseUrl: string;
  private apiKey: string | null;
  private headers: Record<string, string>;
  private contextWindowOverride: number | undefined;
  private supportsVisionOverride: boolean | undefined;
  private modelList?: Promise<any[]>;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey ?? null;
    this.headers = config.headers ?? {};
    this.contextWindowOverride = config.contextWindow;
    this.supportsVisionOverride = config.supportsVision;
  }

  private fetchModelList(): Promise<any[]> {
    if (!this.modelList) {
      this.modelList = (async () => {
        const res = await fetch(`${this.baseUrl}/models`, {
          headers: this.buildHeaders(),
        });
        if (!res.ok) return [];
        const json = (await res.json()) as any;
        return json.data ?? json.models ?? [];
      })().catch(() => []);
    }
    return this.modelList;
  }

  async getModelInfo(): Promise<ModelInfo | undefined> {
    const data = await this.fetchModelList();
    if (!data.length) this.modelList = undefined;
    const entry = data.find(
      (m: any) => String(m?.id ?? m?.name ?? "") === this.model,
    );
    let contextWindow =
      this.contextWindowOverride ?? contextWindowFromModelEntry(entry);
    // llama.cpp nests the usable context under meta; LM Studio exposes it via
    // /api/v0/models. Try those before giving up.
    if (contextWindow === undefined && entry?.meta) {
      const meta = entry.meta as any;
      if (typeof meta?.n_ctx === "number" && meta.n_ctx > 0)
        contextWindow = meta.n_ctx;
      else if (typeof meta?.n_ctx_train === "number" && meta.n_ctx_train > 0)
        contextWindow = meta.n_ctx_train;
    }
    if (contextWindow === undefined) {
      try {
        const root = this.baseUrl.replace(/\/v1\/?$/, "");
        const res = await fetch(`${root}/api/v0/models`);
        if (res.ok) {
          const json = (await res.json()) as any;
          const list = json?.data ?? json?.models ?? [];
          const e = list.find(
            (m: any) => String(m?.id ?? m?.name ?? "") === this.model,
          );
          if (e) {
            if (typeof e?.loaded_context_length === "number" && e.loaded_context_length > 0)
              contextWindow = e.loaded_context_length;
            else {
              const fromEntry = contextWindowFromModelEntry(e);
              if (fromEntry !== undefined) contextWindow = fromEntry;
              else if (typeof e?.max_context_length === "number")
                contextWindow = e.max_context_length;
            }
          }
        }
      } catch {
        // ignore; keep whatever we have
      }
    }
    if (contextWindow === undefined) {
      contextWindow = knownContextWindow(this.model);
    }
    return {
      id: this.model,
      contextWindow,
      supportsTools: true,
      supportsStreaming: true,
      supportsVision:
        this.supportsVisionOverride ??
        supportsVisionFromModelEntry(entry) ??
        knownVisionModel(this.model) ??
        false,
    };
  }

  async listModels(): Promise<string[]> {
    const data = await this.fetchModelList();
    if (!data.length) this.modelList = undefined;
    const ids = data.map((m: any) => m.id ?? m.name).filter(Boolean);
    return ids.length ? ids : [this.model];
  }

  private buildHeaders(requestId?: string): Record<string, string> {
    const h = mergeHeaders(
      { "Content-Type": "application/json" },
      this.headers,
    );
    // A resolved API key wins over a caller-supplied Authorization header,
    // matching the adapter's established precedence.
    if (this.apiKey) {
      setHeader(h, "Authorization", `Bearer ${this.apiKey}`);
    }
    applyRequestId(h, requestId);
    return h;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        lastErr = new Error(
          `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < maxAttempts - 1) {
          await delay(
            200 * (attempt + 1),
            init.signal as AbortSignal | undefined,
          );
          continue;
        }
        throw lastErr;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (isRetryableStatus(res.status)) {
        lastErr = new Error(
          res.status === 429
            ? `PROVIDER_RATE_LIMITED: ${text}`
            : `PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`,
        );
        if (attempt < maxAttempts - 1) {
          await delay(
            retryDelayMs(res, attempt, 500),
            init.signal as AbortSignal | undefined,
          );
          continue;
        }
        throw lastErr;
      }
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    throw lastErr ?? new Error("PROVIDER_INVALID_RESPONSE");
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const model =
      request.model && request.model !== "default" ? request.model : this.model;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toOpenAIMessage),
      stream: false,
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }
    if (request.options) {
      const opts = { ...request.options };
      const effort = resolveReasoningEffort(opts.reasoning ?? opts.effort);
      delete opts.effort;
      delete opts.reasoning;
      if (effort) opts.reasoning_effort = effort;
      Object.assign(body, opts);
    }

    const requestId = resolveRequestId(request.requestId);
    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.buildHeaders(requestId),
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const json = (await res.json()) as any;
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
      name: tc.function?.name,
      arguments: parseArgs(tc.function?.arguments ?? ""),
    }));
    let usage: TokenUsage | undefined = parseOpenAIUsage(json.usage);
  if ((usage === undefined || usage.output === undefined) && json?.timings) {
    const t = json.timings;
    const input = typeof t.prompt_n === "number" ? t.prompt_n : usage?.input;
    const output = typeof t.predicted_n === "number" ? t.predicted_n : usage?.output;
    usage = {
      input,
      output,
      total: typeof input === "number" && typeof output === "number" ? input + output : usage?.total,
      cacheRead: usage?.cacheRead,
      cacheWrite: usage?.cacheWrite,
    };
  }
    return {
      message: {
        role: "assistant",
        content: msg.content
          ? [{ type: "text", text: msg.content }]
          : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: resolveFinishReason(
        choice?.finish_reason,
        toolCalls.length > 0,
      ),
      usage,
      requestId,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    const model =
      request.model && request.model !== "default" ? request.model : this.model;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
      // Ask compatible gateways to send the final usage chunk so the status
      // line can show real context usage instead of cumulative guesses.
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }
    if (request.options) {
      const opts = { ...request.options };
      const effort = resolveReasoningEffort(opts.reasoning ?? opts.effort);
      delete opts.effort;
      delete opts.reasoning;
      if (effort) opts.reasoning_effort = effort;
      Object.assign(body, opts);
    }
    const requestId = resolveRequestId(request.requestId);
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: this.buildHeaders(requestId),
        body: JSON.stringify(body),
        signal: request.signal,
      });
    let res: Response | undefined;
    try {
      // Retry the initial request on transient failures.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await post();
        } catch (err) {
          if (attempt < 2) {
            await delay(200 * (attempt + 1), request.signal);
            continue;
          }
          throw new Error(
            `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (res.ok || !isRetryableStatus(res.status)) break;
        const text = await res.text().catch(() => "");
        if (attempt < 2) {
          await delay(retryDelayMs(res, attempt, 500), request.signal);
          continue;
        }
        throw new Error(
          res.status === 429
            ? `PROVIDER_RATE_LIMITED: ${text}`
            : `PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`,
        );
      }
      if (!res) throw new Error("PROVIDER_INVALID_RESPONSE");
      // Not every OpenAI-compatible gateway accepts stream_options. Retry
      // once without it so chat keeps working (usage will simply be absent).
      if (
        !res.ok &&
        (res.status === 400 || res.status === 422) &&
        "stream_options" in body
      ) {
        const text = await res.text().catch(() => "");
        if (
          /stream_options|include_usage|unknown|unsupported|extra/i.test(text)
        ) {
          delete body.stream_options;
          res = await post();
        } else {
          throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.startsWith("PROVIDER_") ||
          err.message === "USER_CANCELLED")
      )
        throw err;
      throw new Error(
        `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res) throw new Error("PROVIDER_INVALID_RESPONSE");
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (res.status === 429) throw new Error(`PROVIDER_RATE_LIMITED: ${text}`);
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const rawBatches: RawToolCallChunk[][] = [];
    let text = "";
    let usage: TokenUsage | undefined;
    let timings: any;
    let reportedFinishReason: unknown;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          if (json.usage) {
            usage = parseOpenAIUsage(json.usage);
          }
          if (json.timings) {
            timings = json.timings;
          }
          if (json.choices?.[0]?.finish_reason) {
            reportedFinishReason = json.choices[0].finish_reason;
          }
          const delta = json.choices?.[0]?.delta ?? {};
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) {
            yield { type: "thinking", text: reasoning };
          }
          if (delta.content) {
            text += delta.content;
            yield { type: "text", text: delta.content };
          }
          if (delta.tool_calls) {
            rawBatches.push(delta.tool_calls);
          }
        } catch {
          // ignore
        }
      }
    }
    const assembled = assembleToolCalls(rawBatches);
    const finalCalls = toToolCalls(assembled);
    if (
      (usage === undefined || usage.output === undefined) &&
      timings
    ) {
      const input =
        typeof timings.prompt_n === "number" ? timings.prompt_n : usage?.input;
      const output =
        typeof timings.predicted_n === "number"
          ? timings.predicted_n
          : usage?.output;
      usage = {
        input,
        output,
        total:
          typeof input === "number" && typeof output === "number"
            ? input + output
            : usage?.total,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      };
    }
    const response: ModelResponse = {
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : undefined,
        toolCalls: finalCalls.length ? finalCalls : undefined,
      },
      toolCalls: finalCalls,
      finishReason: resolveFinishReason(
        reportedFinishReason,
        finalCalls.length > 0,
      ),
      usage,
      requestId,
    };
    yield { type: "done", response };
  }
}

function toOpenAIMessage(m: any): any {
  if (m.role === "system") return { role: "system", content: m.content };
  if (m.role === "user") {
    const parts = m.content.map((p: any) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : {
            type: "image_url",
            image_url: { url: `data:${p.mime};base64,${p.data}` },
          },
    );
    const hasImage = parts.some((p: any) => p.type === "image_url");
    if (!hasImage) {
      return {
        role: "user",
        content: parts.map((p: any) => p.text ?? "").join(""),
      };
    }
    return { role: "user", content: parts };
  }
  if (m.role === "assistant") {
    const out: any = {
      role: "assistant",
      content:
        m.content
          ?.map((p: any) => (p.type === "text" ? p.text : ""))
          .join("") ?? null,
    };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    if (m.images?.length) {
      const content: any[] = [{ type: "text", text: m.content ?? "" }];
      for (const img of m.images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mime};base64,${img.data}` },
        });
      }
      return { role: "tool", tool_call_id: m.toolCallId, content };
    }
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return m;
}
