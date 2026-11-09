import {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { isWithinWorkspace } from "../security/paths.js";
import { renderAddedLines, renderDiff } from "./diff.js";
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
    const resolved = resolve(ctx.workspace, path);
    const within = isWithinWorkspace(ctx.workspace, path);
    let full = resolved;
    if (!within) {
      // Outside the workspace requires interactive approval.
      if (ctx.approvals?.nonInteractive || !ctx.approvals?.handler) {
        return {
          toolCallId: call.id,
          name: "write",
          content: "PATH_OUTSIDE_WORKSPACE",
          isError: true,
        };
      }
      const { checkApproval } = await import("../runtime/approvals.js");
      const decision = await checkApproval(ctx.approvals, {
        command: `write ${path}`,
        cwd: ctx.workspace,
        timeoutMs: 0,
        sandboxed: false,
      });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: "write",
          content: "WRITE_APPROVAL_REQUIRED",
          isError: true,
        };
      }
      full = resolved;
    }
    // Async read: ENOENT means the file doesn't exist yet (creation path);
    // anything else re-reads and hash-checks the existing file. Non-blocking
    // so parallel tool calls and the TUI keep running.
    let oldText: string | undefined;
    try {
      const buf = await readFile(full);
      oldText = buf.toString("utf8");
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
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // new file: fall through, creation requires no hash
      } else {
        throw err;
      }
    }
    // create parent dirs
    await mkdir(dirname(full), { recursive: true });
    const buf = Buffer.from(content, "utf8");
    // atomic write
    const tmp = full + ".tmp-" + process.pid;
    await writeFile(tmp, buf);
    try {
      await rename(tmp, full);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    const newHash = sha256(buf);
    return {
      toolCallId: call.id,
      name: "write",
      content: `Wrote ${buf.length} bytes to ${path} (sha256:${newHash}).`,
      diff:
        oldText === undefined
          ? renderAddedLines(content)
          : renderDiff(oldText, content),
    };
  },
};
