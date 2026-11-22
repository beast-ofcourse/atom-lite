import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";

const ArgsSchema = z
  .object({
    action: z.enum(["status", "output", "wait", "cancel", "list"]),
    id: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const taskTool: Tool = {
  definition: {
    name: "task",
    description:
      "Query or control background bash tasks. Completion notifies the session automatically, so do not poll; use status/output to inspect, wait to block with a timeout, cancel to stop, and list to enumerate. A wait result includes timed_out when the deadline expired.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "output", "wait", "cancel", "list"],
        },
        id: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        toolCallId: call.id,
        name: "task",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const mgr = ctx.backgroundTasks;
    if (!mgr) {
      return {
        toolCallId: call.id,
        name: "task",
        content: "BACKGROUND_TASKS_UNAVAILABLE",
        isError: true,
      };
    }
    const { action, id, timeoutMs } = parsed.data;
    if (action === "list") {
      return { toolCallId: call.id, name: "task", content: JSON.stringify(mgr.list()) };
    }
    if (!id) {
      return {
        toolCallId: call.id,
        name: "task",
        content: "TOOL_ARGUMENT_INVALID: id is required for this action",
        isError: true,
      };
    }
    if (action === "status" || action === "output") {
      const t = mgr.get(id);
      if (!t)
        return {
          toolCallId: call.id,
          name: "task",
          content: "TASK_NOT_FOUND",
          isError: true,
        };
      return { toolCallId: call.id, name: "task", content: JSON.stringify(t) };
    }
    if (action === "cancel") {
      const t = mgr.cancel(id);
      if (!t)
        return {
          toolCallId: call.id,
          name: "task",
          content: "TASK_NOT_FOUND",
          isError: true,
        };
      return { toolCallId: call.id, name: "task", content: JSON.stringify(t) };
    }
    const outcome = await mgr.waitDetailed(
      id,
      timeoutMs ?? 30_000,
      ctx.signal,
    );
    if (!outcome?.task)
      return {
        toolCallId: call.id,
        name: "task",
        content: "TASK_NOT_FOUND",
        isError: true,
      };
    return {
      toolCallId: call.id,
      name: "task",
      content: JSON.stringify({ ...outcome.task, timed_out: outcome.timedOut }),
    };
  },
};
