import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import type { TodoStatus } from "../runtime/todos.js";

const StatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

const TodoInputSchema = z
  .object({
    id: z.string().optional(),
    content: z.string(),
    status: StatusSchema.optional(),
    verification: z.string().optional(),
  })
  .strict();

const ArgsSchema = z
  .object({
    action: z.enum(["read", "write", "update"]),
    todos: z.array(TodoInputSchema).optional(),
    id: z.string().optional(),
    content: z.string().optional(),
    status: StatusSchema.optional(),
    verification: z.string().optional(),
  })
  .strict();

function snapshot(ctx: ToolContext): Record<string, unknown> {
  const store = ctx.todos;
  if (!store) return { available: false, todos: [] };
  return {
    available: true,
    todos: store.list(),
    counts: store.counts(),
    open: store.openCount(),
  };
}

export const todoTool: Tool = {
  definition: {
    name: "todo",
    description:
      "Maintain the session task ledger. Use action 'write' to replace the list, 'update' to change one item, and 'read' to inspect it. Record every distinct user request, keep statuses current, and mark a task completed only after its verification passes.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "update"],
        },
        todos: {
          type: "array",
          description: "Full replacement list for action 'write'.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
              verification: { type: "string" },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
        id: { type: "string" },
        content: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "cancelled"],
        },
        verification: { type: "string" },
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
        name: "todo",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const store = ctx.todos;
    if (!store) {
      return {
        toolCallId: call.id,
        name: "todo",
        content: "TODO_STORE_UNAVAILABLE",
        isError: true,
      };
    }

    const { action, todos, id, content, status, verification } = parsed.data;
    if (action === "read") {
      return {
        toolCallId: call.id,
        name: "todo",
        content: JSON.stringify(snapshot(ctx)),
      };
    }

    if (action === "write") {
      const items = store.replace(
        (todos ?? []).map((item) => ({
          id: item.id,
          content: item.content,
          status: item.status as TodoStatus | undefined,
          verification: item.verification,
        })),
      );
      return {
        toolCallId: call.id,
        name: "todo",
        content: JSON.stringify({ available: true, todos: items }),
      };
    }

    if (!id) {
      return {
        toolCallId: call.id,
        name: "todo",
        content: "TODO_ID_REQUIRED",
        isError: true,
      };
    }
    const updated = store.update(id, {
      content,
      status: status as TodoStatus | undefined,
      verification,
    });
    if (!updated) {
      return {
        toolCallId: call.id,
        name: "todo",
        content: "TODO_NOT_FOUND",
        isError: true,
      };
    }
    return {
      toolCallId: call.id,
      name: "todo",
      content: JSON.stringify(snapshot(ctx)),
    };
  },
};
