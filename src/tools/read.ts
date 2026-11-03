import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z.object({
  path: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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
      return { toolCallId: call.id, name: "read", content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message, isError: true };
    }
    const { path, offset, limit } = parsed.data;
    if (!isWithinWorkspace(ctx.workspace, path)) {
      return { toolCallId: call.id, name: "read", content: "PATH_OUTSIDE_WORKSPACE", isError: true };
    }
    const full = resolve(ctx.workspace, path);
    if (!existsSync(full)) {
      return { toolCallId: call.id, name: "read", content: "FILE_NOT_FOUND", isError: true };
    }
    const stat = statSync(full);
    if (stat.isDirectory()) {
      return { toolCallId: call.id, name: "read", content: "FILE_NOT_FOUND: path is a directory", isError: true };
    }
    const buf = readFileSync(full);
    if (buf.includes(0)) {
      return { toolCallId: call.id, name: "read", content: `Binary file detected (${buf.length} bytes).`, isError: false };
    }
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    const hash = sha256(buf);
    const header = `File: ${path} (${buf.length} bytes, sha256:${hash})`;
    const body = numbered.length > 0 ? numbered : "(empty)";
    return { toolCallId: call.id, name: "read", content: `${header}\n${body}` };
  },
};