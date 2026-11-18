import type {
  Tool,
  ToolCall,
  ToolResult,
  ToolContext,
} from "../tools/types.js";

/**
 * A wrapper around a tool's `execute`. The first handler registered for a tool
 * is outermost: it runs first and calls `next()` to proceed inward toward the
 * original execution. A handler may replace the result, reject the call by
 * throwing, or abort — returning no result — which surfaces as an error result
 * to the model.
 */
export type ToolMiddlewareHandler = (
  call: ToolCall,
  next: () => Promise<ToolResult>,
) => ToolResult | Promise<ToolResult>;

export interface ToolMiddlewareRegistration {
  toolName: string;
  extensionId: string;
  handler: ToolMiddlewareHandler;
}

/** The loader slice middleware collection needs; kept structural for tests. */
export interface ToolMiddlewareSource {
  list(): Array<{
    status: string;
    id?: string;
    registries: {
      toolMiddleware?: ToolMiddlewareRegistration[];
    };
  }>;
}

/**
 * Collect wrappers in registration order: extensions in loader order, and
 * within an extension the order `wrapTool` was called. Only loaded extensions
 * contribute, so unloaded or failed extensions leave no wrappers behind.
 */
export function collectToolMiddleware(
  loader: ToolMiddlewareSource,
): Map<string, ToolMiddlewareHandler[]> {
  const byTool = new Map<string, ToolMiddlewareHandler[]>();
  for (const loaded of loader.list()) {
    if (loaded.status !== "loaded") continue;
    for (const registration of loaded.registries.toolMiddleware ?? []) {
      const handlers = byTool.get(registration.toolName) ?? [];
      handlers.push(registration.handler);
      byTool.set(registration.toolName, handlers);
    }
  }
  return byTool;
}

function asToolResult(value: unknown, call: ToolCall): ToolResult {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as ToolResult).content === "string"
  ) {
    return value as ToolResult;
  }
  // A stale or timed-out handler yields no result via the boundary. Keep the
  // tool call shape intact so the agent loop can settle it as an error.
  return {
    toolCallId: call.id,
    name: call.name,
    content: "tool middleware produced no result",
    isError: true,
  };
}

/**
 * Compose a tool's execute with every wrapper registered for its name. The
 * original tool object is preserved (definition, annotations, exposure), so a
 * wrapped `hidden` tool stays hidden: wrapping never changes model visibility.
 */
export function applyToolMiddleware(
  tool: Tool,
  handlers: ToolMiddlewareHandler[] | undefined,
): Tool {
  if (!handlers || handlers.length === 0) return tool;
  const base = tool.execute.bind(tool);
  let composed: (
    call: ToolCall,
    ctx: ToolContext,
  ) => Promise<ToolResult> = async (call, ctx) =>
    asToolResult(await base(call, ctx), call);
  // Walk inward so the first handler becomes the outermost call.
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    const inner = composed;
    composed = async (call, ctx) =>
      asToolResult(await handler(call, () => inner(call, ctx)), call);
  }
  return { ...tool, execute: composed };
}
