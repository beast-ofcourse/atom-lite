import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
  TokenUsage,
  Message,
} from "../types.js";
import type { ProviderAdapter } from "./types.js";
import { parseArgs } from "./tool-calls.js";
import { knownVisionModel } from "./context-window.js";
import { isRetryableStatus, retryDelayMs, delay } from "./retry.js";
import { resolveFinishReason } from "./finish-reason.js";
import {
  applyRequestId,
  mergeHeaders,
  resolveRequestId,
} from "./http-headers.js";
import { parseGeminiUsage } from "./usage.js";

export interface GeminiConfig {
  id: string;
  model: string;
  apiKey?: string | null;
  baseUrl?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  supportsVision?: boolean;
}

function toGeminiContents(messages: Message[]): {
  systemInstruction?: any;
  contents: any[];
} {
  const systemParts: any[] = [];
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push({ text: m.content });
      continue;
    }
    if (m.role === "user") {
      contents.push({
        role: "user",
        parts: m.content.map((p: any) =>
          p.type === "text"
            ? { text: p.text }
            : { inlineData: { mimeType: p.mime, data: p.data } },
        ),
      });
      continue;
    }
    if (m.role === "assistant") {
      const parts: any[] = [];
      const text =
        m.content
          ?.map((p: any) => (p.type === "text" ? p.text : ""))
          .join("") ?? "";
      if (text) parts.push({ text });
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.arguments ?? {} },
          });
        }
      }
      // preserve provider state if present
      const state = (m as any).providerState;
      contents.push({
        role: "model",
        parts,
        ...(state ? { _state: state } : {}),
      });
      continue;
    }
    if (m.role === "tool") {
      const parts: any[] = [
        {
          functionResponse: {
            name: m.name,
            response: { result: m.content },
          },
        },
      ];
      for (const img of m.images ?? []) {
        parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
      }
      contents.push({ role: "function", parts });
      continue;
    }
  }
  const systemInstruction = systemParts.length
    ? { parts: systemParts }
    : undefined;
  return { systemInstruction, contents };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id: string;
  public model: string;
  private apiKey: string | null;
  private baseUrl: string;
  private headers: Record<string, string>;
  private contextWindowOverride: number | undefined;
  private supportsVisionOverride: boolean | undefined;
  private modelList?: Promise<any[]>;

  constructor(config: GeminiConfig) {
    this.id = config.id;
    this.model = config.model;
    this.apiKey = config.apiKey ?? null;
    this.baseUrl = (
      config.baseUrl ?? "https://generativelanguage.googleapis.com"
    ).replace(/\/$/, "");
    this.headers = config.headers ?? {};
    this.contextWindowOverride = config.contextWindow;
    this.supportsVisionOverride = config.supportsVision;
  }

  private buildHeaders(requestId?: string): Record<string, string> {
    const headers = mergeHeaders(
      { "Content-Type": "application/json" },
      this.headers,
    );
    applyRequestId(headers, requestId);
    return headers;
  }

  /** Shared request body for generate() and stream(). */
  private buildBody(
    request: ModelRequest,
    systemInstruction: any,
    contents: any[],
  ): any {
    const body: any = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const effort = (request.options as any)?.effort;
    const temperature = (request.options as any)?.temperature;
    if (effort || typeof temperature === "number") {
      body.generationConfig = { ...(body.generationConfig ?? {}) };
      if (effort) {
        const budget =
          effort === "low" ? 1024 : effort === "high" ? 16384 : 4096;
        body.generationConfig.thinkingConfig = { thinkingBudget: budget };
      }
      if (typeof temperature === "number") {
        body.generationConfig.temperature = temperature;
      }
    }
    if (request.tools && request.tools.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }
    return body;
  }

  /** Shared POST with transient-failure retries. */
  private async postWithRetries(
    url: string,
    body: any,
    requestId: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let res: Response | undefined;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(requestId),
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        lastErr = new Error(
          `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < 2) {
          await delay(200 * (attempt + 1), signal);
          continue;
        }
        throw lastErr;
      }
      if (res.ok) break;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (isRetryableStatus(res.status)) {
        lastErr = new Error(
          res.status === 429
            ? `PROVIDER_RATE_LIMITED: ${text}`
            : `PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`,
        );
        if (attempt < 2) {
          await delay(retryDelayMs(res, attempt, 500), signal);
          continue;
        }
        throw lastErr;
      }
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    if (!res || !res.ok)
      throw lastErr ?? new Error("PROVIDER_INVALID_RESPONSE");
    return res;
  }

  private fetchModelList(): Promise<any[]> {
    if (!this.apiKey) return Promise.resolve([]);
    if (!this.modelList) {
      this.modelList = (async () => {
        const res = await fetch(
          `${this.baseUrl}/v1beta/models?key=${encodeURIComponent(this.apiKey!)}`,
          { headers: this.buildHeaders() },
        );
        if (!res.ok) return [];
        const json = (await res.json()) as any;
        return json.models ?? [];
      })().catch(() => []);
    }
    return this.modelList;
  }

  async listModels(): Promise<string[]> {
    const models = await this.fetchModelList();
    if (!models.length) this.modelList = undefined;
    const ids = models
      .map((m: any) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return ids.length ? ids : [this.model];
  }

  async getModelInfo(): Promise<import("../types.js").ModelInfo | undefined> {
    const models = await this.fetchModelList();
    if (!models.length) this.modelList = undefined;
    const entry = models.find(
      (m: any) => (m.name ?? "").replace(/^models\//, "") === this.model,
    );
    const limit = entry?.inputTokenLimit;
    return {
      id: this.model,
      contextWindow:
        this.contextWindowOverride ??
        (typeof limit === "number" && limit > 0
          ? Math.floor(limit)
          : undefined),
      supportsTools: true,
      supportsStreaming: true,
      supportsVision:
        this.supportsVisionOverride ?? knownVisionModel(this.model) ?? false,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error("PROVIDER_AUTH_FAILED: missing API key");
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body = this.buildBody(request, systemInstruction, contents);
    const requestId = resolveRequestId(request.requestId);
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.postWithRetries(
      url,
      body,
      requestId,
      request.signal,
    );
    const json = (await res.json()) as any;
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const thinkingParts = parts
      .filter((p: any) => p.thought && typeof p.text === "string")
      .map((p: any) => p.text);
    const textParts = parts
      .filter((p: any) => !p.thought && typeof p.text === "string")
      .map((p: any) => p.text);
    const text = textParts.join("");
    const thinking = thinkingParts.join("");
    const toolCalls: ToolCall[] = parts
      .filter((p: any) => p.functionCall)
      .map((p: any, i: number) => ({
        id: `gemini_${i}`,
        name: p.functionCall.name,
        arguments: parseArgs(JSON.stringify(p.functionCall.args ?? {})),
      }));
    const usage: TokenUsage | undefined = parseGeminiUsage(json.usageMetadata);
    // safety block handling
    if (candidate?.finishReason === "SAFETY") {
      throw new Error("PROVIDER_INVALID_RESPONSE: safety block");
    }
    return {
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        providerState: candidate?.content,
      },
      toolCalls,
      finishReason: resolveFinishReason(
        candidate?.finishReason,
        toolCalls.length > 0,
      ),
      usage,
      metadata: thinking ? { thinking } : undefined,
      requestId,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!this.apiKey) throw new Error("PROVIDER_AUTH_FAILED: missing API key");
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body = this.buildBody(request, systemInstruction, contents);
    const requestId = resolveRequestId(request.requestId);
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.postWithRetries(
      url,
      body,
      requestId,
      request.signal,
    );

    let text = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;
    let providerState: any;
    let safety = false;
    let reportedFinishReason: unknown;

    // One SSE chunk (or one element of a plain-JSON array) may carry several
    // parts. Emit text/thinking immediately; tool calls go in the done event.
    const handle = (json: any): ModelStreamEvent[] => {
      const out: ModelStreamEvent[] = [];
      if (!json || typeof json !== "object") return out;
      if (json.usageMetadata) usage = parseGeminiUsage(json.usageMetadata);
      for (const candidate of Array.isArray(json.candidates)
        ? json.candidates
        : []) {
        if (candidate?.finishReason === "SAFETY") safety = true;
        if (candidate?.finishReason)
          reportedFinishReason = candidate.finishReason;
        const parts = candidate?.content?.parts ?? [];
        if (candidate?.content && parts.length) {
          providerState = candidate.content;
        }
        for (const part of parts) {
          if (typeof part?.text !== "string") continue;
          if (part.thought) {
            thinking += part.text;
            out.push({ type: "thinking", text: part.text });
          } else {
            text += part.text;
            out.push({ type: "text", text: part.text });
          }
        }
        for (const part of parts) {
          if (!part?.functionCall) continue;
          toolCalls.push({
            id: `gemini_${toolCalls.length}`,
            name: part.functionCall.name,
            arguments: parseArgs(JSON.stringify(part.functionCall.args ?? {})),
          });
        }
      }
      return out;
    };

    const isSse = (res.headers.get("content-type") ?? "").includes(
      "event-stream",
    );
    if (isSse && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeData = (data: string): ModelStreamEvent[] => {
        if (!data || data === "[DONE]") return [];
        try {
          return handle(JSON.parse(data));
        } catch {
          return [];
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          for (const event of consumeData(trimmed.slice(5).trim())) yield event;
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith("data:")) {
        for (const event of consumeData(tail.slice(5).trim())) yield event;
      }
    } else {
      // Some compatible gateways ignore alt=sse and return one JSON body.
      const json: any = await res.json().catch(() => undefined);
      const chunks = Array.isArray(json) ? json : [json];
      for (const chunk of chunks) {
        for (const event of handle(chunk)) yield event;
      }
    }

    if (safety) throw new Error("PROVIDER_INVALID_RESPONSE: safety block");
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: text ? [{ type: "text", text }] : undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          providerState,
        },
        toolCalls,
        finishReason: resolveFinishReason(
          reportedFinishReason,
          toolCalls.length > 0,
        ),
        usage,
        metadata: thinking ? { thinking } : undefined,
        requestId,
      },
    };
  }
}
