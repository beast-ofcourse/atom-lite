import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";

const ArgsSchema = z
  .object({
    action: z.enum(["status", "output", "wait", "cancel"]),
    id: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const taskTool: Tool = {
  definition: {
    name: "task",
    description: "Query or control a background task started by bash with background:true.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "output", "wait", "cancel"] },
        id: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
      },
      required: ["action", "id"],
      additionalProperties: false,
    },
  },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return { toolCallId: call.id, name: "task", content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message, isError: true };
    }
    const mgr = ctx.backgroundTasks;
    if (!mgr) {
      return { toolCallId: call.id, name: "task", content: "BACKGROUND_TASKS_UNAVAILABLE", isError: true };
    }
    const { action, id, timeoutMs } = parsed.data;
    if (action === "status" || action === "output") {
      const t = mgr.get(id) ?? mgr.output(id);
      if (!t) return { toolCallId: call.id, name: "task", content: "TASK_NOT_FOUND", isError: true };
      return { toolCallId: call.id, name: "task", content: JSON.stringify(t) };
    }
    if (action === "cancel") {
      const t = mgr.cancel(id);
      if (!t) return { toolCallId: call.id, name: "task", content: "TASK_NOT_FOUND", isError: true };
      return { toolCallId: call.id, name: "task", content: JSON.stringify(t) };
    }
    if (action === "wait") {
      const t = await mgr.wait(id, timeoutMs ?? 30000);
      if (!t) return { toolCallId: call.id, name: "task", content: "TASK_NOT_FOUND", isError: true };
      return { toolCallId: call.id, name: "task", content: JSON.stringify(t) };
    }
    return { toolCallId: call.id, name: "task", content: "INVALID_ACTION", isError: true };
  },
};