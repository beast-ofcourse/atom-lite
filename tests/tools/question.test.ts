import { test } from "node:test";
import assert from "node:assert/strict";
import { questionTool } from "../../dist/tools/question.js";
import { QUESTION_UNAVAILABLE } from "../../dist/runtime/questions.js";
import { ToolExecutor } from "../../dist/runtime/tool-executor.js";

const questions = [
  {
    question: "What should happen?",
    header: "Action",
    options: [{ label: "Build", description: "Build it" }],
  },
  {
    question: "Which environment?",
    header: "Environment",
    options: [{ label: "Dev", description: "Development" }],
    multiple: true,
  },
  {
    question: "Anything else?",
    header: "Optional",
    options: [],
  },
];

function makeCtx(
  handler?: (
    request: { questions: any[] },
    signal?: AbortSignal,
  ) => Promise<any>,
) {
  return {
    workspace: "/tmp",
    signal: new AbortController().signal,
    questions: { handler, nonInteractive: handler === undefined },
  };
}

function call(id: string, args: Record<string, unknown> = { questions }) {
  return { id, name: "question", arguments: args };
}

test("question rejects an empty questions array", async () => {
  const result = await questionTool.execute(
    call("q1", { questions: [] }),
    makeCtx(async () => ({ status: "cancelled" })),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /TOOL_ARGUMENT_INVALID/);
});

test("question returns a model-facing error without an interactive handler", async () => {
  const result = await questionTool.execute(call("q1"), makeCtx());
  assert.equal(result.isError, true);
  assert.equal(result.content, QUESTION_UNAVAILABLE);
});

test("question projects answers in order and uses OpenCode model text", async () => {
  let captured: any;
  const result = await questionTool.execute(
    call("q1"),
    makeCtx(async (request) => {
      captured = request;
      return { status: "answered", answers: [["Build"], ["Dev"], []] };
    }),
  );

  assert.equal(captured.questions.length, 3);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    answers: [["Build"], ["Dev"], []],
  });
  assert.deepEqual(result.structuredContent, {
    answers: [["Build"], ["Dev"], []],
  });
  assert.equal(
    result.content,
    'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
  );
});

test("question maps a single answer to a one-element array", async () => {
  const result = await questionTool.execute(
    call("q1", {
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    }),
    makeCtx(async () => ({ status: "answered", answers: [["Yes"]] })),
  );
  assert.deepEqual(result.details, { answers: [["Yes"]] });
  assert.match(result.content, /"Continue\?"="Yes"/);
});

test("question dismissal is marked and not projected as an answer", async () => {
  const result = await questionTool.execute(
    call("q1"),
    makeCtx(async () => ({ status: "cancelled" })),
  );
  assert.equal(result.isError, true);
  assert.equal(result.content, "The user dismissed this question");
  assert.deepEqual(result.details, { questionDismissed: true });
});

test("question cancellation with a message becomes model-facing feedback", async () => {
  const result = await questionTool.execute(
    call("q1"),
    makeCtx(async () => ({
      status: "cancelled",
      message: "client disconnected",
    })),
  );
  assert.equal(result.isError, true);
  assert.equal(result.content, "client disconnected");
  assert.equal(result.details, undefined);
});

test("question runs in plan mode", async () => {
  const executor = new ToolExecutor({ maxParallelToolCalls: 2 });
  const ctx = makeCtx(async () => ({ status: "answered", answers: [["Yes"]] }));
  const results = await executor.run(
    [
      call("q1", {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      }),
    ],
    {
      ...ctx,
      mode: "plan",
      toolMap: new Map([["question", questionTool]]),
    },
    ctx.signal,
  );
  assert.equal(results[0].isError, undefined);
  assert.match(results[0].content, /answered your questions/);
});

test("two question calls in one batch run one at a time", async () => {
  let active = 0;
  let peak = 0;
  const executor = new ToolExecutor({ maxParallelToolCalls: 4 });
  const ctx = makeCtx(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { status: "answered", answers: [["Yes"]] };
  });
  const one = {
    questions: [
      {
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      },
    ],
  };
  const results = await executor.run(
    [call("q1", one), call("q2", one)],
    { ...ctx, toolMap: new Map([["question", questionTool]]) },
    ctx.signal,
  );
  assert.equal(results.length, 2);
  assert.equal(peak, 1);
});
