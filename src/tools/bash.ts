import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { isWithinWorkspace } from "../security/paths.js";
import { defaultShell, terminateProcessTree } from "../security/process.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { z } from "zod";

const ArgsSchema = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    background: z.boolean().optional(),
  })
  .strict();

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description: "Execute a shell command and return its output. Set background:true to run asynchronously.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1 },
        background: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "bash",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const { command, cwd, timeout_ms, background } = parsed.data;
    if (background) {
      if (!ctx.backgroundTasks) {
        return { toolCallId: call.id, name: "bash", content: "BACKGROUND_TASKS_UNAVAILABLE", isError: true };
      }
      const workdir = cwd ? resolve(ctx.workspace, cwd) : ctx.workspace;
      if (cwd && !isWithinWorkspace(ctx.workspace, cwd)) {
        return { toolCallId: call.id, name: "bash", content: "PATH_OUTSIDE_WORKSPACE", isError: true };
      }
      try {
        const task = ctx.backgroundTasks.start(command, workdir, process.env);
        return { toolCallId: call.id, name: "bash", content: JSON.stringify(task) };
      } catch (err) {
        return { toolCallId: call.id, name: "bash", content: `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
    const capMs = ctx.maxBashTimeMs ?? 120000;
    const timeout = Math.min(timeout_ms ?? capMs, capMs);
    const workdir = cwd ? resolve(ctx.workspace, cwd) : ctx.workspace;
    if (cwd && !isWithinWorkspace(ctx.workspace, cwd)) {
      return {
        toolCallId: call.id,
        name: "bash",
        content: "PATH_OUTSIDE_WORKSPACE",
        isError: true,
      };
    }
    if (ctx.mode !== "yolo" && ctx.approvals) {
      const { checkApproval } = await import("../runtime/approvals.js");
      const decision = await checkApproval(ctx.approvals, {
        command,
        cwd: workdir,
        timeoutMs: timeout,
        sandboxed: false,
      });
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: "bash",
          content: "COMMAND_APPROVAL_REQUIRED",
          isError: true,
        };
      }
    }
    const shell = defaultShell();
    const flag = process.platform === "win32" ? "/c" : "-c";
    const start = Date.now();
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(shell, [flag, command], {
        cwd: workdir,
        env: process.env,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const cap = ctx.maxToolOutputBytes ?? 30000;
      const append = (target: "out" | "err", chunk: Buffer) => {
        const s = chunk.toString("utf8");
        let accepted = s;
        if (target === "out") {
          if (stdout.length + s.length > cap) {
            truncated = true;
            accepted = s.slice(0, Math.max(0, cap - stdout.length));
            stdout += accepted;
          } else {
            stdout += s;
          }
        } else {
          if (stderr.length + s.length > cap) {
            truncated = true;
            accepted = s.slice(0, Math.max(0, cap - stderr.length));
            stderr += accepted;
          } else {
            stderr += s;
          }
        }
        if (accepted) {
          ctx.onToolOutput?.(
            call,
            target === "out" ? "stdout" : "stderr",
            accepted,
          );
        }
      };
      child.stdout?.on("data", (c: Buffer) => append("out", c));
      child.stderr?.on("data", (c: Buffer) => append("err", c));
      let timedOut = false;
      let killedByAbort = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM");
        setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
      }, timeout);
      const onAbort = () => {
        killedByAbort = true;
        terminateProcessTree(child, "SIGTERM");
        setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise({
          toolCallId: call.id,
          name: "bash",
          content: `COMMAND_FAILED: ${err.message}`,
          isError: true,
        });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const duration = Date.now() - start;
        const parts: string[] = [];
        parts.push(`exit_code: ${code ?? "null"}`);
        if (signal) parts.push(`signal: ${signal}`);
        if (timedOut) parts.push("timed_out: true");
        if (killedByAbort) parts.push("cancelled: true");
        if (truncated) parts.push("OUTPUT_TRUNCATED");
        parts.push(`duration_ms: ${duration}`);
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        const failed = code !== 0 || timedOut || killedByAbort;
        resolvePromise({
          toolCallId: call.id,
          name: "bash",
          content: parts.join("\n"),
          isError: failed,
        });
      });
    });
  },
};
