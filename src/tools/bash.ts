import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
    description:
      "Execute a shell command in the workspace (or the optional cwd) and return its output. Set background:true to run asynchronously. Commands run in the workspace root unless cwd is provided; a previous cd does not persist between calls.",
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
        return {
          toolCallId: call.id,
          name: "bash",
          content: "BACKGROUND_TASKS_UNAVAILABLE",
          isError: true,
        };
      }
      const workdir = cwd ? resolve(ctx.workspace, cwd) : ctx.workspace;
      if (cwd && !isWithinWorkspace(ctx.workspace, cwd)) {
        return {
          toolCallId: call.id,
          name: "bash",
          content: "PATH_OUTSIDE_WORKSPACE",
          isError: true,
        };
      }
      try {
        const task = ctx.backgroundTasks.start(command, workdir, process.env);
        return {
          toolCallId: call.id,
          name: "bash",
          content: JSON.stringify({
            task_id: task.id,
            status: "started",
            command,
          }),
        };
      } catch (err) {
        return {
          toolCallId: call.id,
          name: "bash",
          content: `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }
    const capMs = ctx.maxBashTimeMs ?? 120000;
    const timeout = Math.min(timeout_ms ?? capMs, capMs);
    const workdir = cwd ? resolve(ctx.workspace, cwd) : ctx.workspace;
    const cwdOutside = !!cwd && !isWithinWorkspace(ctx.workspace, cwd);
    if (cwdOutside) {
      if (ctx.approvals?.nonInteractive || !ctx.approvals?.handler) {
        return {
          toolCallId: call.id,
          name: "bash",
          content: "PATH_OUTSIDE_WORKSPACE",
          isError: true,
        };
      }
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
      let settled = false;
      const child = spawn(shell, [flag, command], {
        cwd: workdir,
        env: process.env,
        detached: process.platform !== "win32",
        // stdin: "ignore" gives commands that read stdin an immediate EOF
        // instead of blocking forever on a pipe that never closes.
        stdio: ["ignore", "pipe", "pipe"],
      });
      const cap = ctx.maxToolOutputBytes ?? 30000;
      const decoder = {
        out: new StringDecoder("utf8"),
        err: new StringDecoder("utf8"),
      };
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let pipesDestroyed = false;
      const remaining = (target: "out" | "err") =>
        Math.max(0, cap - (target === "out"
          ? Buffer.byteLength(stdout, "utf8")
          : Buffer.byteLength(stderr, "utf8")));
      const consume = (target: "out" | "err", s: string): string => {
        if (s === "") return "";
        let accepted = s;
        const rem = remaining(target);
        if (Buffer.byteLength(s, "utf8") > rem) {
          truncated = true;
          // Byte-accurate cut: may split a trailing multibyte character, which
          // surfaces as U+FFFD (at most 2 bytes of overshoot) — well within
          // the spirit of the cap.
          accepted = Buffer.from(s, "utf8").subarray(0, rem).toString("utf8");
        }
        if (target === "out") stdout += accepted;
        else stderr += accepted;
        if (accepted) {
          ctx.onToolOutput?.(
            call,
            target === "out" ? "stdout" : "stderr",
            accepted,
          );
        }
        return accepted;
      };
      const append = (target: "out" | "err", chunk: Buffer) => {
        const s = decoder[target].write(chunk);
        consume(target, s);
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
      // The child 'close' event only fires once every stdio stream has
      // closed. If the command leaves a descendant (daemon, watcher, dev
      // server started with '&' or setsid) inheriting our pipes, 'close'
      // never fires and the agent would hang forever. Once the shell itself
      // has exited, stop waiting on stragglers: after a short grace period
      // destroy the pipes, which emits 'close' with the exit already
      // collected.
      let closeGuard: NodeJS.Timeout | undefined;
      const watchForClosedPipes = () => {
        if (closeGuard) return;
        closeGuard = setTimeout(() => {
          pipesDestroyed = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 2000);
        closeGuard.unref();
      };
      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (closeGuard) clearTimeout(closeGuard);
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
      child.on("error", (err) => {
        finish({
          toolCallId: call.id,
          name: "bash",
          content: `COMMAND_FAILED: ${err.message}`,
          isError: true,
        });
      });
      child.on("exit", () => {
        watchForClosedPipes();
      });
      child.on("close", (code, signal) => {
        // Flush any bytes remaining buffered in the decoder, through the same
        // cap accounting as live chunks.
        try {
          consume("out", decoder.out.end());
          consume("err", decoder.err.end());
        } catch {
          // Ignore decoder errors at close.
        }
        const duration = Date.now() - start;
        const parts: string[] = [];
        parts.push(`exit_code: ${code ?? "null"}`);
        if (signal) parts.push(`signal: ${signal}`);
        if (timedOut) parts.push("timed_out: true");
        if (killedByAbort) parts.push("cancelled: true");
        if (pipesDestroyed)
          parts.push(
            "warning: descendant processes kept result output pipes open; remaining descendant output was not collected",
          );
        if (truncated) parts.push("OUTPUT_TRUNCATED");
        parts.push(`duration_ms: ${duration}`);
        parts.push(`cwd: ${workdir}`);
        if (
          /(^|\s)(sed\s+-i|perl\s+-[a-z]*i|python[0-9.]*\s+-\s*<<|cat\s*>\s*\S+\.(ts|js|tsx|jsx|py|go|rs|md))/i.test(
            command,
          )
        ) {
          parts.push(
            "warning: shell-based file editing detected; prefer the edit/write tools for hash-guarded, diffable changes",
          );
        }
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        const failed = code !== 0 || timedOut || killedByAbort;
        finish({
          toolCallId: call.id,
          name: "bash",
          content: parts.join("\n"),
          isError: failed,
        });
      });
    });
  },
};
