import type { ToolCall } from "../types.js";

export interface RawToolCallChunk {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

export function assembleToolCalls(
  chunks: RawToolCallChunk[][],
): AssembledToolCall[] {
  const calls: { id: string; name: string; raw: string }[] = [];
  for (const batch of chunks) {
    for (const tc of batch) {
      const idx = tc.index ?? calls.length;
      if (!calls[idx]) {
        calls[idx] = {
          id: tc.id ?? `call_${idx}`,
          name: tc.function?.name ?? "",
          raw: "",
        };
      }
      if (tc.id) calls[idx].id = tc.id;
      if (tc.function?.name) calls[idx].name = tc.function.name;
      if (tc.function?.arguments) calls[idx].raw += tc.function.arguments;
    }
  }
  return calls.filter(Boolean).map((c) => ({
    id: c.id,
    name: c.name,
    rawArguments: c.raw,
    arguments: parseArgs(c.raw),
  }));
}

export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
    throw new Error("not an object");
  } catch {
    throw new Error("PROVIDER_INVALID_RESPONSE: malformed tool arguments");
  }
}

export function toToolCalls(assembled: AssembledToolCall[]): ToolCall[] {
  return assembled.map((a) => ({
    id: a.id,
    name: a.name as ToolCall["name"],
    arguments: a.arguments,
  }));
}
