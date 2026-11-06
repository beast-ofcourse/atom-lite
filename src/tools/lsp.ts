import { z } from "zod";
import type { Tool, ToolCall, ToolContext, ToolResult } from "./types.js";
import * as lsp from "../lsp/index.js";

const DiagnosticsSchema = z
  .object({
    path: z.string().optional(),
  })
  .strict();

const PositionSchema = z
  .object({
    path: z.string(),
    line: z.number().int().positive(),
    character: z.number().int().nonnegative().default(1),
  })
  .strict();

const SymbolsSchema = z
  .object({
    path: z.string().optional(),
    query: z.string().optional(),
  })
  .strict();

function result(call: ToolCall, content: unknown, isError = false): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    content:
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    isError,
  };
}

export const lspDiagnosticsTool: Tool = {
  definition: {
    name: "lsp_diagnostics",
    description:
      "Get LSP diagnostics for a file or all open files. LSP must be enabled in config.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall): Promise<ToolResult> {
    const parsed = DiagnosticsSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return result(
        call,
        "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        true,
      );
    }
    if (!lsp.lspEnabled()) {
      return result(call, "LSP_DISABLED: enable lsp.enabled in config", true);
    }
    const diagnostics = await lsp.getDiagnostics(parsed.data.path);
    const obj = Object.fromEntries(diagnostics);
    return result(call, obj);
  },
};

export const lspDefinitionTool: Tool = {
  definition: {
    name: "lsp_definition",
    description:
      "Find the definition of a symbol using LSP. Lines are 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
        character: { type: "integer", minimum: 0 },
      },
      required: ["path", "line"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall): Promise<ToolResult> {
    const parsed = PositionSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return result(
        call,
        "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        true,
      );
    }
    if (!lsp.lspEnabled()) {
      return result(call, "LSP_DISABLED: enable lsp.enabled in config", true);
    }
    const data = await lsp.definition(
      parsed.data.path,
      parsed.data.line,
      parsed.data.character || 1,
    );
    return result(call, data ?? []);
  },
};

export const lspReferencesTool: Tool = {
  definition: {
    name: "lsp_references",
    description: "Find references to a symbol using LSP. Lines are 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
        character: { type: "integer", minimum: 0 },
      },
      required: ["path", "line"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall): Promise<ToolResult> {
    const parsed = PositionSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return result(
        call,
        "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        true,
      );
    }
    if (!lsp.lspEnabled()) {
      return result(call, "LSP_DISABLED: enable lsp.enabled in config", true);
    }
    const data = await lsp.references(
      parsed.data.path,
      parsed.data.line,
      parsed.data.character || 1,
    );
    return result(call, data ?? []);
  },
};

export const lspSymbolsTool: Tool = {
  definition: {
    name: "lsp_symbols",
    description:
      "Get document symbols for a file, or workspace symbols for a query.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall): Promise<ToolResult> {
    const parsed = SymbolsSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return result(
        call,
        "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        true,
      );
    }
    if (!lsp.lspEnabled()) {
      return result(call, "LSP_DISABLED: enable lsp.enabled in config", true);
    }
    if (parsed.data.query) {
      const data = await lsp.workspaceSymbols(parsed.data.query);
      return result(call, data ?? []);
    }
    if (!parsed.data.path) {
      return result(
        call,
        "TOOL_ARGUMENT_INVALID: path or query required",
        true,
      );
    }
    const data = await lsp.documentSymbols(parsed.data.path);
    return result(call, data ?? []);
  },
};
