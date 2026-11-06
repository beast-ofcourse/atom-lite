import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
  TokenUsage,
  ModelInfo,
} from "../types.js";
import type { ProviderAdapter } from "./types.js";
import { parseArgs } from "./tool-calls.js";
import { knownVisionModel } from "./context-window.js";

export interface OllamaConfig {
  id?: string;
  baseUrl?: string;
  model: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  keepAlive?: string | number;
  think?: boolean | string;
  options?: Record<string, unknown>;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id: string;
  private baseUrl: string;
  public model: string;
  private headers: Record<string, string>;
  private keepAlive: string | number | undefined;
  private think: boolean | string | undefined;
  private options: Record<string, unknown>;
  private contextWindow: number | undefined;
  private supportsToolsFlag: boolean;
  private supportsStreamingFlag: boolean;
  private supportsVisionFlag: boolean | undefined;
  private supportsVisionOverride: boolean | undefined;

  constructor(config: OllamaConfig) {
    this.id = config.id ?? "ollama";
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:11434").replace(
      /\/$/,
      "",
    );
    this.model = config.model;
    this.headers = config.headers ?? {};
    this.keepAlive = config.keepAlive;
    this.think = config.think;
    this.options = config.options ?? {};
    this.contextWindow = config.contextWindow;
    this.supportsToolsFlag = config.supportsTools ?? true;
    this.supportsStreamingFlag = config.supportsStreaming ?? true;
    this.supportsVisionFlag = undefined;
    this.supportsVisionOverride = config.supportsVision;
  }

  // Capability metadata (multiple access styles for compatibility).
  get capabilities(): {
    toolCalling: boolean;
    streaming: boolean;
    contextWindow: number | undefined;
  } {
    return {
      toolCalling: this.supportsToolsFlag,
      streaming: this.supportsStreamingFlag,
      contextWindow: this.contextWindow,
    };
  }

  get supportsTools(): boolean {
    return this.supportsToolsFlag;
  }

  get supportsStreaming(): boolean {
    return this.supportsStreamingFlag;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };
    return h;
  }

  private resolveModel(request: ModelRequest): string {
    return request.model && request.model !== "default"
      ? request.model
      : this.model;
  }

  private toOllamaMessages(messages: ModelRequest["messages"]): any[] {
    return messages.map((m: any) => {
      if (m.role === "system") {
        return { role: "system", content: m.content };
      }
      if (m.role === "user") {
        const content = Array.isArray(m.content)
          ? m.content
              .map((p: any) => (p?.type === "text" ? p.text : ""))
              .join("")
          : String(m.content ?? "");
        return { role: "user", content };
      }
      if (m.role === "assistant") {
        const content =
          m.content
            ?.map((p: any) => (p?.type === "text" ? p.text : ""))
            .join("") ?? "";
        const out: any = { role: "assistant", content };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc: any) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments ?? {},
            },
          }));
        }
        return out;
      }
      if (m.role === "tool") {
        const out: any = { role: "tool", content: m.content };
        if (m.name) out.tool_name = m.name;
        if (m.toolCallId) out.tool_call_id = m.toolCallId;
        return out;
      }
      return m;
    });
  }

  private buildBody(
    request: ModelRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const model = this.resolveModel(request);
    const body: Record<string, unknown> = {
      model,
      messages: this.toOllamaMessages(request.messages),
      stream,
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

    // Merge options: constructor defaults + request.options (flat or nested).
    const mergedOptions: Record<string, unknown> = { ...this.options };
    const reqOpts = (request.options ?? {}) as Record<string, unknown>;
    if (reqOpts.options && typeof reqOpts.options === "object") {
      Object.assign(mergedOptions, reqOpts.options as Record<string, unknown>);
    }
    for (const [k, v] of Object.entries(reqOpts)) {
      if (
        k === "options" ||
        k === "keep_alive" ||
        k === "think" ||
        k === "effort"
      )
        continue;
      mergedOptions[k] = v;
    }
    if (Object.keys(mergedOptions).length) body.options = mergedOptions;

    const keepAlive =
      reqOpts.keep_alive !== undefined ? reqOpts.keep_alive : this.keepAlive;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;

    let think = reqOpts.think !== undefined ? reqOpts.think : this.think;
    if (think === undefined && reqOpts.effort !== undefined) {
      think = reqOpts.effort;
    }
    if (think !== undefined) body.think = think;

    return body;
  }

  private parseToolCalls(raw: any, startIndex = 0): ToolCall[] {
    const out: ToolCall[] = [];
    const list = raw?.message?.tool_calls ?? raw?.tool_calls ?? [];
    (Array.isArray(list) ? list : []).forEach((tc: any, i: number) => {
      out.push({
        id: tc?.id ?? tc?.tool_call_id ?? `call_${startIndex + i}`,
        name: tc?.function?.name ?? tc?.name,
        arguments:
          typeof tc?.function?.arguments === "string"
            ? parseArgs(tc.function.arguments)
            : (tc?.function?.arguments ?? tc?.arguments ?? {}),
      });
    });
    return out;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) return [this.model];
      const json = (await res.json()) as any;
      const models = json.models ?? [];
      const ids = models.map((m: any) => m.name ?? m.model).filter(Boolean);
      return ids.length ? ids : [this.model];
    } catch {
      return [this.model];
    }
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl}/api/chat`;
    const body = this.buildBody(request, false);
    let res: Response | undefined;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (err) {
        lastErr = new Error(
          `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      if (res.ok) break;
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error(`PROVIDER_AUTH_FAILED: ${text}`);
      if (res.status === 429) {
        lastErr = new Error(`PROVIDER_RATE_LIMITED: ${text}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    if (!res || !res.ok)
      throw lastErr ?? new Error("PROVIDER_INVALID_RESPONSE");
    const json = (await res.json()) as any;
    const toolCalls = this.parseToolCalls(json);
    const text = json?.message?.content ?? "";
    const usage: TokenUsage | undefined =
      json?.prompt_eval_count !== undefined || json?.eval_count !== undefined
        ? {
            input: json.prompt_eval_count,
            output: json.eval_count,
            total:
              (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0) ||
              undefined,
          }
        : undefined;
    return {
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage,
      metadata: json,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const url = `${this.baseUrl}/api/chat`;
    const body = this.buildBody(request, true);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw new Error(
        `PROVIDER_CONNECTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`PROVIDER_INVALID_RESPONSE: ${res.status} ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls: ToolCall[] = [];
    let text = "";
    let finalJson: any = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let json: any;
        try {
          json = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const chunkThinking = json?.message?.thinking;
        if (chunkThinking) {
          yield { type: "thinking", text: chunkThinking };
        }
        const chunkText = json?.message?.content;
        if (chunkText) {
          text += chunkText;
          yield { type: "text", text: chunkText };
        }
        const chunkCalls = this.parseToolCalls(json);
        if (chunkCalls.length) {
          // merge by index
          chunkCalls.forEach((tc, i) => {
            if (!toolCalls[i]) toolCalls[i] = tc;
            else {
              if (tc.id && tc.id !== `call_${i}`) toolCalls[i].id = tc.id;
              if (tc.name) toolCalls[i].name = tc.name;
              if (tc.arguments && Object.keys(tc.arguments).length)
                toolCalls[i].arguments = tc.arguments;
            }
          });
        }
        if (json?.done) {
          finalJson = json;
        }
      }
    }
    // handle any trailing buffered line
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer.trim());
        const chunkThinking = json?.message?.thinking;
        if (chunkThinking) {
          yield { type: "thinking", text: chunkThinking };
        }
        const chunkText = json?.message?.content;
        if (chunkText) {
          text += chunkText;
          yield { type: "text", text: chunkText };
        }
        const chunkCalls = this.parseToolCalls(json);
        if (chunkCalls.length) {
          chunkCalls.forEach((tc, i) => {
            if (!toolCalls[i]) toolCalls[i] = tc;
          });
        }
        if (json?.done) finalJson = json;
      } catch {
        // ignore incomplete tail
      }
    }

    const finalCalls = toolCalls.filter(Boolean);
    const usage: TokenUsage | undefined = finalJson
      ? {
          input: finalJson.prompt_eval_count,
          output: finalJson.eval_count,
          total:
            (finalJson.prompt_eval_count ?? 0) + (finalJson.eval_count ?? 0) ||
            undefined,
        }
      : undefined;
    const response: ModelResponse = {
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : undefined,
        toolCalls: finalCalls.length ? finalCalls : undefined,
      },
      toolCalls: finalCalls,
      finishReason: finalCalls.length ? "tool_calls" : "stop",
      usage,
      metadata: finalJson ?? undefined,
    };
    yield { type: "done", response };
  }

  async getModelInfo(): Promise<ModelInfo | undefined> {
    // Try Ollama /api/show for context length; fall back to configured/unknown.
    try {
      const res = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ name: this.model }),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const info = json?.model_info ?? {};
        let ctx: number | undefined;
        for (const [k, v] of Object.entries(info)) {
          if (
            k.toLowerCase().includes("context_length") &&
            typeof v === "number"
          ) {
            ctx = v;
            break;
          }
        }
        if (ctx) this.contextWindow = ctx;
        const caps = json?.capabilities;
        if (Array.isArray(caps)) {
          this.supportsToolsFlag = caps.includes("tools");
          if (this.supportsVisionOverride === undefined) {
            this.supportsVisionFlag = caps.includes("vision");
          }
        }
      }
    } catch {
      // ignore; keep defaults
    }
    return {
      id: this.model,
      contextWindow: this.contextWindow,
      supportsTools: this.supportsToolsFlag,
      supportsStreaming: this.supportsStreamingFlag,
      supportsVision:
        this.supportsVisionOverride ??
        this.supportsVisionFlag ??
        knownVisionModel(this.model) ??
        false,
    };
  }

  // Doctor / connectivity helpers.
  async doctor(): Promise<{
    ok: boolean;
    connectivity: boolean;
    model: string;
    supportsTools: boolean;
    contextWindow: number | undefined;
    error?: string;
  }> {
    return this.healthCheck();
  }

  async healthCheck(): Promise<{
    ok: boolean;
    connectivity: boolean;
    model: string;
    supportsTools: boolean;
    contextWindow: number | undefined;
    error?: string;
  }> {
    let connectivity = false;
    let error: string | undefined;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        headers: this.buildHeaders(),
      });
      connectivity = res.ok;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const info = await this.getModelInfo().catch(() => undefined);
    return {
      ok: connectivity,
      connectivity,
      model: this.model,
      supportsTools: info?.supportsTools ?? this.supportsToolsFlag,
      contextWindow: info?.contextWindow ?? this.contextWindow,
      error,
    };
  }

  async checkConnectivity(): Promise<boolean> {
    const r = await this.healthCheck();
    return r.connectivity;
  }

  async verifyToolCalling(): Promise<boolean> {
    const info = await this.getModelInfo().catch(() => undefined);
    return info?.supportsTools ?? this.supportsToolsFlag;
  }
}

// Aliases for compatibility with various naming conventions.
export const OllamaProvider = OllamaAdapter;
export type OllamaProvider = OllamaAdapter;

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return (s as Record<string, unknown>) ?? {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
