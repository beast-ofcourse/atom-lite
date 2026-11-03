import type { ModelRequest, ModelResponse, ModelStreamEvent, ToolCall, TokenUsage } from "../types.js";
import type { ProviderAdapter } from "./types.js";
import { parseArgs, assembleToolCalls, toToolCalls, type RawToolCallChunk } from "./tool-calls.js";

export interface OpenAICompatibleConfig {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  public model: string;
  private baseUrl: string;
  private apiKey: string | null;
  private headers: Record<string, string>;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.apiKey = config.apiKey ?? null;
    this.headers = config.headers ?? {};
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...this.headers };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        lastErr = new Error(`PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (res.status === 429) {
        lastErr = new Error(`PROVIDER_RATE_LIMITED: ${text}`);
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
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
    const model = request.model && request.model !== "default" ? request.model : this.model;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toOpenAIMessage),
      stream: false,
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (request.options) {
      const opts = { ...request.options };
      const effort = opts.effort;
      delete opts.effort;
      if (effort) opts.reasoning_effort = effort;
      Object.assign(body, opts);
    }

    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: this.buildHeaders(),
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
    const usage: TokenUsage | undefined = json.usage
      ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens, total: json.usage.total_tokens }
      : undefined;
    return {
      message: {
        role: "assistant",
        content: msg.content ? [{ type: "text", text: msg.content }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    const model = request.model && request.model !== "default" ? request.model : this.model;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (request.options) {
      const opts = { ...request.options };
      const effort = opts.effort;
      delete opts.effort;
      if (effort) opts.reasoning_effort = effort;
      Object.assign(body, opts);
    }
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: this.buildHeaders(), body: JSON.stringify(body), signal: request.signal });
    } catch (err) {
      throw new Error(`PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (res.status === 429) throw new Error(`PROVIDER_RATE_LIMITED: ${text}`);
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const rawBatches: RawToolCallChunk[][] = [];
    let text = "";
    let usage: TokenUsage | undefined;
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
            usage = {
              input: json.usage.prompt_tokens,
              output: json.usage.completion_tokens,
              total: json.usage.total_tokens,
            };
          }
          const delta = json.choices?.[0]?.delta ?? {};
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
    const response: ModelResponse = {
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : undefined,
        toolCalls: finalCalls.length ? finalCalls : undefined,
      },
      toolCalls: finalCalls,
      finishReason: finalCalls.length ? "tool_calls" : "stop",
      usage,
    };
    yield { type: "done", response };
  }
}

function toOpenAIMessage(m: any): any {
  if (m.role === "system") return { role: "system", content: m.content };
  if (m.role === "user") return { role: "user", content: m.content.map((p: any) => (p.type === "text" ? p.text : "")).join("") };
  if (m.role === "assistant") {
    const out: any = { role: "assistant", content: m.content?.map((p: any) => (p.type === "text" ? p.text : "")).join("") ?? null };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return m;
}