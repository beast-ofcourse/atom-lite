import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    expected_hash: z.string().optional(),
  })
  .strict();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const writeTool: Tool = {
  definition: {
    name: "write",
    description: "Create a new file or replace the full contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expected_hash: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "write",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { path, content, expected_hash } = parsed.data;
    if (!isWithinWorkspace(ctx.workspace, path)) {
      return {
        toolCallId: call.id,
        name: "write",
        content: "PATH_OUTSIDE_WORKSPACE",
        isError: true,
      };
    }
    const full = resolve(ctx.workspace, path);
    const existed = existsSync(full);
    if (existed) {
      const buf = readFileSync(full);
      const currentHash = sha256(buf);
      if (expected_hash && expected_hash !== currentHash) {
        return {
          toolCallId: call.id,
          name: "write",
          content: "FILE_CHANGED_SINCE_READ",
          isError: true,
        };
      }
      if (!expected_hash) {
        return {
          toolCallId: call.id,
          name: "write",
          content:
            "TOOL_ARGUMENT_INVALID: expected_hash required when replacing an existing file",
          isError: true,
        };
      }
    }
    // create parent dirs
    mkdirSync(dirname(full), { recursive: true });
    const buf = Buffer.from(content, "utf8");
    // atomic write
    const tmp = full + ".tmp-" + process.pid;
    writeFileSync(tmp, buf);
    renameSync(tmp, full);
    const newHash = sha256(buf);
    return {
      toolCallId: call.id,
      name: "write",
      content: `Wrote ${buf.length} bytes to ${path} (sha256:${newHash}).`,
    };
  },
};
