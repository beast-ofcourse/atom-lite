import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { checkGoalCompletion } from "../runtime/goal.js";

const ArgsSchema = z
  .object({
    action: z.enum(["read", "complete"]),
    evidence: z.string().optional(),
  })
  .strict();

function unavailable(call: ToolCall, code: string): ToolResult {
  return {
    toolCallId: call.id,
    name: "goal",
    content: code,
    isError: true,
  };
}

export const goalTool: Tool = {
  definition: {
    name: "goal",
    description:
      "Read the session goal or mark it complete with evidence. The statement, criteria, status, and constraints are user-owned; this tool cannot change them. Complete succeeds only when every success criterion is backed by a completed todo or by the evidence you supply.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "complete"],
        },
        evidence: {
          type: "string",
          description:
            "Text showing how each remaining success criterion was met.",
        },
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
        name: "goal",
        content: "TOOL_ARGUMENT_INVALID: " + parsed.error.message,
        isError: true,
      };
    }
    const store = ctx.goal;
    if (!store) return unavailable(call, "GOAL_STORE_UNAVAILABLE");
    const goal = store.get();
    if (!goal) return unavailable(call, "GOAL_NOT_SET");

    if (parsed.data.action === "read") {
      return {
        toolCallId: call.id,
        name: "goal",
        content: JSON.stringify({ available: true, goal }),
      };
    }

    const check = checkGoalCompletion(
      goal,
      ctx.todos?.list() ?? [],
      parsed.data.evidence,
    );
    if (!check.complete) {
      return {
        toolCallId: call.id,
        name: "goal",
        content:
          "GOAL_CRITERIA_UNMET: " +
          (check.unmet.length ? check.unmet.join("; ") : "no goal is set"),
        isError: true,
      };
    }
    return {
      toolCallId: call.id,
      name: "goal",
      content: JSON.stringify({
        available: true,
        completed: true,
        goal: store.complete(),
      }),
    };
  },
};
