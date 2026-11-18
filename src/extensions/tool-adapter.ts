import { createHash } from "node:crypto";
import type { Tool, ToolResult } from "../tools/types.js";
import type { ToolCall, ToolContext } from "../tools/types.js";
import type { ExtensionTool, ExtensionContext } from "./types.js";
import {
  applyToolMiddleware,
  collectToolMiddleware,
  type ToolMiddlewareHandler,
  type ToolMiddlewareRegistration,
} from "./tool-middleware.js";

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
  const properties = (schema?.properties ?? {}) as Record<
    string,
    SchemaProperty
  >;
  for (const [key, prop] of Object.entries(properties)) {
    if (result[key] === undefined) continue;
    const type = prop?.type;
    if (result[key] === null) {
      // A null is a value the model deliberately sent. Keep it even for
      // non-required properties; coercion below is a no-op for null.
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

/** Reserved schema property that carries the definition hash to the model. */
export const TOOL_HASH_PARAM = "__atomToolHash";

function definitionHash(tool: ExtensionTool): string {
  const material = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? {},
    exposure: tool.exposure ?? "direct",
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

export function extensionToolToAgentTool(
  extensionTool: ExtensionTool,
  extensionContext: ExtensionContext,
  extensionId?: string,
): Tool {
  const hash = definitionHash(extensionTool);
  const attribution = extensionId ? `[extension:${extensionId}] ` : "";
  const original = (extensionTool.parameters ?? {}) as Record<string, unknown>;
  const originalProperties =
    original.properties && typeof original.properties === "object"
      ? (original.properties as Record<string, unknown>)
      : {};
  const originalRequired = Array.isArray(original.required)
    ? (original.required as string[])
    : [];
  // The model receives a hash it must echo back. A call made against an older
  // definition carries a different hash and is rejected before execute runs.
  const parameters: Record<string, unknown> = {
    ...original,
    properties: {
      ...originalProperties,
      [TOOL_HASH_PARAM]: {
        type: "string",
        enum: [hash],
        description:
          "Definition version token. Echo the value from the tool definition.",
      },
    },
    required: [...originalRequired, TOOL_HASH_PARAM],
  };
  const tool: Tool = {
    definition: {
      name: extensionTool.name,
      description: extensionTool.description,
      parameters,
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
      const presented = (coerced as Record<string, unknown>)[TOOL_HASH_PARAM];
      delete coerced[TOOL_HASH_PARAM];
      call.arguments = coerced;
      if (presented !== undefined && presented !== hash) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `${attribution}Tool "${call.name}" definition changed since this call was made (expected ${hash}, got ${String(presented)}). Retry with the current definition.`,
          isError: true,
        };
      }
      const signal = toolCtx.signal;
      const onUpdate = (partial: unknown) => {
        toolCtx.onToolOutput?.(call, "stdout", JSON.stringify(partial));
      };
      const ctx = { ...extensionContext };
      let raw: any;
      try {
        // One uniform signature. Function.length is not a reliable arity:
        // default parameters reduce it, and an explicit declaration is not
        // required of extension authors.
        raw = await extensionTool.execute(
          call.id,
          coerced,
          signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `${attribution}COMMAND_FAILED: ${error instanceof Error ? error.message : String(error)}`,
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

export interface ToolSourceLoader {
  list: () => Array<{
    status: string;
    id?: string;
    registries: {
      tools: Map<string, ExtensionTool>;
      activeTools?: Set<string> | null;
      toolMiddleware?: ToolMiddlewareRegistration[];
    };
    context?: ExtensionContext;
  }>;
}

/**
 * Collect model-visible extension tools. Hidden tools are excluded here but
 * stay in their extension's registry, so commands and other tools can still
 * call them. Names are made unique before the list reaches AgentRuntime, whose
 * tool map would otherwise silently let the last tool win.
 */
export function collectExtensionTools(
  loader: ToolSourceLoader,
  reservedNames: Iterable<string> = [],
): Tool[] {
  const out: Tool[] = [];
  const claimedNames = new Set<string>();
  const middleware = collectToolMiddleware(loader);
  for (const name of reservedNames) claimedNames.add(name);
  for (const loaded of loader.list()) {
    // Only successfully activated extensions contribute tools to the model.
    if (loaded.status !== "loaded") continue;
    const id = loaded.id ?? "extension";
    const ctx = loaded.context ?? {
      workspace: process.cwd(),
      trusted: true,
      hasUI: false,
      ui: null as any,
      log: () => {},
    };
    const active = loaded.registries.activeTools;
    for (const tool of loaded.registries.tools.values()) {
      // setActiveTools narrows the model-visible set; registration still keeps
      // the tool available to commands and other tools.
      if (active && !active.has(tool.name)) continue;
      // Only `hidden` is withheld from the model. `codemode` and `deferred`
      // are tolerated as model-visible tools with their annotations intact;
      // callers that cannot render those modes still receive a usable schema.
      if ((tool.exposure ?? "direct") === "hidden") continue;
      const base = tool.name;
      let name = base;
      if (claimedNames.has(name)) {
        name = `${id}_${base}`;
        let suffix = 2;
        while (claimedNames.has(name)) name = `${id}_${base}_${suffix++}`;
        // The author must learn that their tool was renamed, not discover it
        // from a missing tool call later.
        ctx.log?.(
          `tool "${base}" renamed to "${name}" because its name is already in use`,
        );
      }
      claimedNames.add(name);
      // Wrap by the name the author registered, before any collision rename.
      // Hidden tools were filtered above, so a wrapper can never make one
      // model-visible.
      const wrapped = applyToolMiddleware(
        extensionToolToAgentTool({ ...tool, name }, ctx, loaded.id ?? id),
        middleware.get(tool.name),
      );
      out.push(wrapped);
    }
  }
  return out;
}

export interface ToolResolutionOptions {
  builtInTools?: Tool[];
  mcpTools?: Tool[];
  loader?: ToolSourceLoader | null;
  /** False for --no-tools: no tool definitions reach the model at all. */
  useTools?: boolean;
}

/**
 * Resolve the complete model-visible tool set from current state. Call this at
 * every refresh point (turn start, MCP change, reload, trust approval) so a
 * runtime tool mutation or reload is reflected on the next turn. No caller
 * keeps a cached snapshot.
 */
export function resolveModelTools(options: ToolResolutionOptions): Tool[] {
  if (options.useTools === false) return [];
  const reservedNames = [
    ...(options.builtInTools ?? []),
    ...(options.mcpTools ?? []),
  ].map((tool) => tool.definition.name);
  const middleware = options.loader
    ? collectToolMiddleware(options.loader)
    : new Map<string, ToolMiddlewareHandler[]>();
  const hostTools = [
    ...(options.builtInTools ?? []),
    ...(options.mcpTools ?? []),
  ].map((tool) =>
    applyToolMiddleware(tool, middleware.get(tool.definition.name)),
  );
  const extensionTools = options.loader
    ? collectExtensionTools(options.loader, reservedNames)
    : [];
  return [
    ...hostTools.slice(0, options.builtInTools?.length ?? 0),
    ...extensionTools,
    ...hostTools.slice(options.builtInTools?.length ?? 0),
  ];
}
