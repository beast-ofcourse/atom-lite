import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Drop the CR from CRLF without scanning the whole file up front. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Return the requested line range without splitting the entire file. Partial
 * reads (offset/limit) are common for large files, where slicing first keeps
 * the cost proportional to the requested window instead of the file size.
 */
function sliceLines(text: string, offset?: number, limit?: number): string[] {
  let start = 0;
  const startLine = (offset ?? 1) - 1;
  for (let i = 0; i < startLine; i++) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return [];
    start = nl + 1;
  }
  if (limit === undefined) {
    return text.slice(start).split("\n").map(stripCr);
  }
  let cursor = start;
  for (let i = 0; i < limit; i++) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) {
      // Fewer lines remain than requested: take the rest, including the
      // trailing newline so the split matches a full-file slice.
      return text.slice(start).split("\n").map(stripCr);
    }
    cursor = nl + 1;
  }
  return text.slice(start, cursor - 1).split("\n").map(stripCr);
}

export const readTool: Tool = {
  definition: {
    name: "read",
    description: "Read a file or a selected range of lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { path, offset, limit } = parsed.data;
    if (!isWithinWorkspace(ctx.workspace, path)) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "PATH_OUTSIDE_WORKSPACE",
        isError: true,
      };
    }
    const full = resolve(ctx.workspace, path);
    if (!existsSync(full)) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "FILE_NOT_FOUND",
        isError: true,
      };
    }
    const stat = statSync(full);
    if (stat.isDirectory()) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "FILE_NOT_FOUND: path is a directory",
        isError: true,
      };
    }
    if (stat.size > 10 * 1024 * 1024) {
      return {
        toolCallId: call.id,
        name: "read",
        content: "FILE_TOO_LARGE",
        isError: true,
      };
    }
    const buf = readFileSync(full);
    if (buf.includes(0)) {
      return {
        toolCallId: call.id,
        name: "read",
        content: `Binary file detected (${buf.length} bytes).`,
        isError: false,
      };
    }
    const text = buf.toString("utf8");
    const start = (offset ?? 1) - 1;
    const slice = sliceLines(text, offset, limit);
    const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    const hash = sha256(buf);
    const header = `File: ${path} (${buf.length} bytes, sha256:${hash})`;
    const body = numbered.length > 0 ? numbered : "(empty)";
    const cap = ctx.maxToolOutputBytes ?? 30000;
    let content = `${header}\n${body}`;
    if (content.length > cap) {
      content = content.slice(0, cap) + "\nOUTPUT_TRUNCATED";
    }
    return { toolCallId: call.id, name: "read", content };
  },
};
