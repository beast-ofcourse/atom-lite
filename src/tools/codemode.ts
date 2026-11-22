import { Effect } from "effect";
import { CodeMode, Tool as CodeModeTool } from "../codemode/index.js";
import type { AgentRuntime } from "../agent/loop.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export interface CodeModeLimits {
  timeoutMs?: number;
  maxToolCalls?: number;
  maxOutputBytes?: number;
}

export function createCodeModeTool(
  runtime: AgentRuntime,
  baseTools: readonly { definition: { name: string; description: string; parameters: Record<string, unknown> } }[],
  limits: CodeModeLimits = {},
): Tool {
  const atomTools = baseTools.filter((tool) => tool.definition.name !== "execute");

  const tools: Record<string, unknown> = {};
  for (const atomTool of atomTools) {
    const name = atomTool.definition.name;
    const codeModeTool = CodeModeTool.make({
      description: atomTool.definition.description,
      input: atomTool.definition.parameters as CodeModeTool.JsonSchema,
      output: {} as CodeModeTool.JsonSchema,
      execute: (input: unknown, context: { key: string }) =>
        Effect.promise(async () => {
          const atomContext = runtime.getCodeModeContext();
          if (!atomContext) {
            throw new Error("Code Mode has no active turn context.");
          }
          return runtime.runToolForCodeMode(name, input, context, atomContext);
        }),
    });

    // Tool names using dots or MCP's `__` separator become nested namespaces,
    // so `mcp__server__tool` is callable as `tools.mcp.server.tool(...)`.
    const segments = name.split(/\.|__/).filter(Boolean);
    let current: Record<string, unknown> = tools;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (
        typeof current[segment] !== "object" ||
        current[segment] === null ||
        Array.isArray(current[segment])
      ) {
        current[segment] = {};
      }
      current = current[segment] as Record<string, unknown>;
    }
    current[segments[segments.length - 1]] = codeModeTool;
  }

  const resolvedLimits = {
    timeoutMs: limits.timeoutMs ?? 30000,
    maxToolCalls: limits.maxToolCalls ?? 100,
    maxOutputBytes: limits.maxOutputBytes ?? 100000,
  };

  const toolNames = atomTools.map((tool) => tool.definition.name).join(", ");

  return {
    definition: {
      name: "execute",
      description:
        "Run JavaScript in a confined Code Mode runtime to orchestrate multiple Atom Lite tools in one execution. " +
        "Write plain JavaScript; intermediate tool results stay inside the runtime and only the final result is returned. " +
        "Dotted or `__` tool names become nested namespaces. Call tools as `await tools.<name>({ ... })`, " +
        "in parallel with `Promise.allSettled`. " +
        `Available tools: ${toolNames}.`,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
    async execute(call, _ctx): Promise<ToolResult> {
      const code = String((call.arguments as { code?: unknown })?.code ?? "");
      const result = await Effect.runPromise(
        CodeMode.execute({
          code,
          tools: tools as never,
          limits: resolvedLimits,
        }),
        { signal: _ctx.signal },
      );

      const output =
        result.ok === true
          ? JSON.stringify(result.value)
          : `Code Mode failed (${result.error.kind}): ${result.error.message}`;

      const logs = Array.isArray(result.logs) ? result.logs.join("\n") : "";
      const content = [output, logs].filter(Boolean).join("\n\n");

      return {
        toolCallId: call.id,
        name: "execute",
        content,
        isError: result.ok !== true,
        details: {
          toolCalls: result.toolCalls,
          truncated: result.truncated,
          warnings: (result as any).warnings,
        },
      };
    },
  };
}