import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

function detectImageMime(path: string, buf: Buffer): string | null {
  const ext = extname(path).toLowerCase();
  const byExt: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  let magic: string | null = null;
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) magic = "image/png";
    else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) magic = "image/jpeg";
    else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) magic = "image/gif";
    else if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") magic = "image/webp";
  }
  if (byExt[ext]) return magic ?? byExt[ext];
  return magic;
}

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

/** Split on LF, stripping CRs only when the text actually contains any. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  return text.includes("\r") ? lines.map(stripCr) : lines;
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
    return splitLines(text.slice(start));
  }
  let cursor = start;
  for (let i = 0; i < limit; i++) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) {
      // Fewer lines remain than requested: take the rest, including the
      // trailing newline so the split matches a full-file slice.
      return splitLines(text.slice(start));
    }
    cursor = nl + 1;
  }
  return splitLines(text.slice(start, cursor - 1));
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
    const mime = detectImageMime(full, buf);
    if (mime) {
      if (!ctx.supportsVision) {
        return {
          toolCallId: call.id,
          name: "read",
          content: "vision not supported by current model",
          isError: true,
        };
      }
      return {
        toolCallId: call.id,
        name: "read",
        content: `Image file: ${path} (${buf.length} bytes, ${mime})`,
        images: [{ data: buf.toString("base64"), mime }],
      };
    }
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
