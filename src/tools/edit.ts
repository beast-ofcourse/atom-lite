import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import { renderDiff } from "./diff.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    expected_hash: z.string().optional(),
  })
  .strict();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const editTool: Tool = {
  definition: {
    name: "edit",
    description:
      "Make a precise find-and-replace modification to an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        expected_hash: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { path, old_string, new_string, expected_hash } = parsed.data;
    if (old_string === "") {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "TOOL_ARGUMENT_INVALID: old_string must not be empty",
        isError: true,
      };
    }
    const resolved = resolve(ctx.workspace, path);
    const within = isWithinWorkspace(ctx.workspace, path);
    let full = resolved;
    if (!within) {
      if (ctx.approvals?.nonInteractive || !ctx.approvals?.handler) {
        return {
          toolCallId: call.id,
          name: "edit",
          content: "PATH_OUTSIDE_WORKSPACE",
          isError: true,
        };
      }
      const { checkApproval } = await import("../runtime/approvals.js");
      const decision = await checkApproval(ctx.approvals, {
        command: `edit ${path}`,
        cwd: ctx.workspace,
        timeoutMs: 0,
        sandboxed: false,
      });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: "edit",
          content: "EDIT_APPROVAL_REQUIRED",
          isError: true,
        };
      }
      full = resolved;
    }
    let buf: Buffer;
    try {
      buf = await readFile(full);
    } catch {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "FILE_NOT_FOUND",
        isError: true,
      };
    }
    const currentHash = sha256(buf);
    if (expected_hash && expected_hash !== currentHash) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "FILE_CHANGED_SINCE_READ",
        isError: true,
      };
    }
    const text = buf.toString("utf8");
    // Single pass: locate the unique match and count occurrences together
    // instead of scanning the whole text twice.
    let matchIndex = -1;
    let count = 0;
    let idx = text.indexOf(old_string);
    while (idx !== -1) {
      if (matchIndex === -1) matchIndex = idx;
      count++;
      if (count > 1) break; // ambiguous already
      idx = text.indexOf(old_string, idx + old_string.length);
    }
    if (count === 0) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "EDIT_NOT_FOUND",
        isError: true,
      };
    }
    if (count > 1) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "EDIT_AMBIGUOUS_MATCH",
        isError: true,
      };
    }
    const newText =
      text.slice(0, matchIndex) +
      new_string +
      text.slice(matchIndex + old_string.length);
    const newBuf = Buffer.from(newText, "utf8");
    const tmp = full + ".tmp-" + process.pid;
    await writeFile(tmp, newBuf);
    try {
      await rename(tmp, full);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    const newHash = sha256(newBuf);
    return {
      toolCallId: call.id,
      name: "edit",
      content: `Edited ${path} (sha256:${newHash}).`,
      diff: renderDiff(text, newText),
    };
  },
};
