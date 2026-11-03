import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
  TokenUsage,
  Message,
} from "../types.js";
import type { ProviderAdapter } from "./types.js";

export interface GeminiConfig {
  id: string;
  model: string;
  apiKey?: string | null;
  baseUrl?: string;
  headers?: Record<string, string>;
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
          p.type === "text" ? { text: p.text } : p,
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
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: m.name,
              response: { result: m.content },
            },
          },
        ],
      });
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

  constructor(config: GeminiConfig) {
    this.id = config.id;
    this.model = config.model;
    this.apiKey = config.apiKey ?? null;
    this.baseUrl = (
      config.baseUrl ?? "https://generativelanguage.googleapis.com"
    ).replace(/\/$/, "");
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error("PROVIDER_AUTH_FAILED: missing API key");
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body: any = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
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
    let res: Response | undefined;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textParts = parts
      .filter((p: any) => typeof p.text === "string")
      .map((p: any) => p.text);
    const text = textParts.join("");
    const toolCalls: ToolCall[] = parts
      .filter((p: any) => p.functionCall)
      .map((p: any, i: number) => ({
        id: `gemini_${i}`,
        name: p.functionCall.name,
        arguments: p.functionCall.args ?? {},
      }));
    const usage: TokenUsage | undefined = json.usageMetadata
      ? {
          input: json.usageMetadata.promptTokenCount,
          output: json.usageMetadata.candidatesTokenCount,
          total: json.usageMetadata.totalTokenCount,
        }
      : undefined;
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
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage,
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const resp = await this.generate(request);
    if (resp.message.content?.[0]?.type === "text") {
      yield { type: "text", text: (resp.message.content[0] as any).text };
    }
    yield { type: "done", response: resp };
  }
}
