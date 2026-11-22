import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";

const ArgsSchema = z
  .object({
    action: z.enum(["status", "output", "wait", "cancel", "list", "start"]),
    id: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    kind: z.enum(["shell", "subagent", "image", "codemode"]).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    path: z.string().optional(),
    model: z.string().optional(),
    agent: z.string().optional(),
  })
  .strict();

export const taskTool: Tool = {
  definition: {
    name: "task",
    description:
      "Start, query, or control background jobs. Completion notifies the session automatically, so do not poll. Use start with a kind (shell, subagent, image, codemode) and params to launch work; status/output inspect, wait blocks with a timeout, cancel stops, and list enumerates. A wait result includes timed_out when the deadline expired.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "output", "wait", "cancel", "list", "start"],
        },
        id: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
        kind: {
          type: "string",
          enum: ["shell", "subagent", "image", "codemode"],
        },
        params: { type: "object" },
        title: { type: "string" },
        description: { type: "string" },
        path: { type: "string" },
        model: { type: "string" },
        agent: { type: "string" },
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
    const { action, id, timeoutMs, kind, params, title, description, path, model, agent } = parsed.data;
    if (action === "start") {
      if (!kind)
        return {
          toolCallId: call.id,
          name: "task",
          content: "TOOL_ARGUMENT_INVALID: kind is required for start",
          isError: true,
        };
      if (!mgr.hasProducer(kind))
        return {
          toolCallId: call.id,
          name: "task",
          content: `NO_PRODUCER_FOR_${kind}`,
          isError: true,
        };
      const fields: Record<string, unknown> = {};
      if (title !== undefined) fields.title = title;
      if (description !== undefined) fields.description = description;
      if (path !== undefined) fields.path = path;
      if (model !== undefined) fields.model = model;
      if (agent !== undefined) fields.agent = agent;
      const job = mgr.startProducedJob(kind, params ?? {}, fields);
      return {
        toolCallId: call.id,
        name: "task",
        content: JSON.stringify({
          task_id: job.id,
          status: "running",
          outputPath: job.outputPath,
          notice:
            "Job started in the background. You will be notified when it finishes; do not poll.",
        }),
      };
    }
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
