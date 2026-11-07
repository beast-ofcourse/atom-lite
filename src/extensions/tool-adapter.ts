import type { Tool, ToolResult } from "../tools/types.js";
import type { ToolCall, ToolContext } from "../tools/types.js";
import type { ExtensionTool, ExtensionContext } from "./types.js";

interface SchemaProperty {
  type?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

type CoercedValue =
  | string
  | number
  | boolean
  | null
  | CoercedValue[]
  | { [key: string]: CoercedValue };

export function coerceToolArguments(
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(input ?? {}) };
  const properties = (schema?.properties ?? {}) as Record<string, SchemaProperty>;
  const required = Array.isArray(schema?.required)
    ? (schema.required as string[])
    : [];
  for (const [key, prop] of Object.entries(properties)) {
    if (result[key] === undefined) continue;
    const type = prop?.type;
    if (result[key] === null && !required.includes(key)) {
      delete result[key];
      continue;
    }
    if (type === "number" || type === "integer") {
      if (typeof result[key] === "string") {
        const n = Number(result[key]);
        if (!Number.isNaN(n)) result[key] = n;
      } else if (typeof result[key] === "boolean") {
        result[key] = result[key] ? 1 : 0;
      }
    } else if (type === "boolean") {
      if (typeof result[key] === "string") {
        if (result[key] === "true") result[key] = true;
        if (result[key] === "false") result[key] = false;
      } else if (typeof result[key] === "number") {
        result[key] = result[key] !== 0;
      }
    } else if (type === "string") {
      if (result[key] !== null && typeof result[key] !== "string") {
        result[key] = String(result[key]);
      }
    } else if (type === "array") {
      if (!Array.isArray(result[key]) && result[key] !== null) {
        result[key] = [result[key]];
      }
      if (Array.isArray(result[key]) && prop?.items) {
        result[key] = (result[key] as unknown[]).map((item) =>
          typeof prop.items === "object" && prop.items?.type
            ? coerceScalar(prop.items, item)
            : item,
        );
      }
    } else if (type === "object" && prop?.properties) {
      if (result[key] && typeof result[key] === "object") {
        result[key] = coerceToolArguments(
          prop,
          result[key] as Record<string, unknown>,
        );
      }
    }
  }
  return result;
}

function coerceScalar(prop: SchemaProperty, value: unknown): CoercedValue {
  if (value === null) return null;
  const type = prop?.type;
  if (type === "number" || type === "integer") {
    if (typeof value === "string") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    return value as CoercedValue;
  }
  if (type === "boolean" && typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value as CoercedValue;
  }
  if (type === "string" && value !== null && typeof value !== "string") {
    return String(value);
  }
  return value as CoercedValue;
}

export function extensionToolToAgentTool(
  extensionTool: ExtensionTool,
  extensionContext: ExtensionContext,
): Tool {
  const tool: Tool = {
    definition: {
      name: extensionTool.name,
      description: extensionTool.description,
      parameters: extensionTool.parameters ?? {},
    },
    annotations: extensionTool.annotations,
    exposure: extensionTool.exposure,
    execute: async (
      call: ToolCall,
      toolCtx: ToolContext,
    ): Promise<ToolResult> => {
      const coerced = coerceToolArguments(
        extensionTool.parameters,
        call.arguments ?? {},
      );
      call.arguments = coerced;
      const signal = toolCtx.signal;
      const onUpdate = (partial: unknown) => {
        toolCtx.onToolOutput?.(call, "stdout", JSON.stringify(partial));
      };
      const ctx = { ...extensionContext };
      let raw: any;
      try {
        if (extensionTool.execute.length >= 3) {
          raw = await extensionTool.execute(
            call.id,
            coerced,
            signal,
            onUpdate,
            ctx,
          );
        } else if (extensionTool.execute.length === 2) {
          raw = await extensionTool.execute(coerced, ctx);
        } else {
          raw = await extensionTool.execute(coerced);
        }
      } catch (error) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `COMMAND_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      const content = Array.isArray(raw?.content)
        ? raw.content
            .map((part: any) =>
              part?.type === "text" ? String(part.text ?? "") : "",
            )
            .join("")
        : typeof raw === "string"
          ? raw
          : raw === undefined
            ? ""
            : JSON.stringify(raw);

      return {
        toolCallId: call.id,
        name: call.name,
        content,
        isError: raw?.isError === true,
        details: raw?.details,
        structuredContent: raw?.structuredContent,
        usage: raw?.usage,
        diff: raw?.diff,
      };
    },
  };
  return tool;
}

export function collectExtensionTools(loader: {
  list: () => Array<{
    registries: { tools: Map<string, ExtensionTool> };
    context?: ExtensionContext;
  }>;
}): Tool[] {
  const out: Tool[] = [];
  for (const loaded of loader.list()) {
    const ctx = loaded.context ?? {
      workspace: process.cwd(),
      trusted: true,
      hasUI: false,
      ui: null as any,
      log: () => {},
    };
    for (const tool of loaded.registries.tools.values()) {
      out.push(extensionToolToAgentTool(tool, ctx));
    }
  }
  return out;
}
