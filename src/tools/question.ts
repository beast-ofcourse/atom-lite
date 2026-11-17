import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../types.js";
import { askQuestion, type QuestionPrompt } from "../runtime/questions.js";

const OptionSchema = z
  .object({
    label: z.string(),
    description: z.string(),
  })
  .strict();

const PromptSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(OptionSchema),
    multiple: z.boolean().optional(),
  })
  .strict();

const ArgsSchema = z
  .object({
    questions: z.array(PromptSchema).min(1),
  })
  .strict();

const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`;

/** Exact model-facing projection used by OpenCode. */
export function toModelContent(
  questions: readonly QuestionPrompt[],
  answers: readonly (readonly string[])[],
): string {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

function failure(call: ToolCall, content: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content, isError: true };
}

export const questionTool: Tool = {
  definition: {
    name: "question",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "Complete question" },
              header: {
                type: "string",
                description: "Very short label (max 30 chars)",
              },
              options: {
                type: "array",
                description: "Available choices",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display text (1-5 words, concise)",
                    },
                    description: {
                      type: "string",
                      description: "Explanation of choice",
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting multiple choices",
              },
            },
            required: ["question", "header", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  annotations: { readOnlyHint: true },
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return failure(call, "TOOL_ARGUMENT_INVALID: " + parsed.error.message);
    }
    const questions = parsed.data.questions as QuestionPrompt[];
    const outcome = await askQuestion(ctx.questions, { questions }, ctx.signal);

    if (outcome.status === "cancelled") {
      if (outcome.message !== undefined) {
        return failure(call, outcome.message);
      }
      // A dismissal is not model-facing output: the loop stops the step after
      // recording this result. Keep a message so the transcript stays coherent.
      return {
        toolCallId: call.id,
        name: call.name,
        content: "The user dismissed this question",
        isError: true,
        details: { questionDismissed: true },
      };
    }

    const answers = questions.map((_, index): string[] => [
      ...(outcome.answers[index] ?? []),
    ]);
    return {
      toolCallId: call.id,
      name: call.name,
      content: toModelContent(questions, answers),
      details: { answers },
      structuredContent: { answers },
    };
  },
};
