import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { questionTool } from "../../dist/tools/index.js";
import { QuestionPromptView } from "../../dist/cli/question-prompt.js";
import { ansiTheme } from "../../dist/cli/theme.js";

test("runtime drives the prompt and returns selected answers to the model", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "q1",
          name: "question",
          arguments: {
            questions: [
              {
                question: "What should happen?",
                header: "Action",
                options: [{ label: "Build", description: "Build it" }],
              },
              {
                question: "Which environment?",
                header: "Environment",
                options: [{ label: "Dev", description: "Development" }],
              },
            ],
          },
        },
      ],
    },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: "/tmp",
    tools: [questionTool],
    questions: {
      handler: (request) =>
        new Promise((resolve) => {
          const view = new QuestionPromptView({
            questions: request.questions,
            theme: ansiTheme,
            onOutcome: resolve,
          });
          // Pick the first option on each field, land on review, then submit.
          view.handleInput("1");
          view.handleInput("\r");
          view.handleInput("\r");
        }),
      nonInteractive: false,
    },
  });
  const session = new InMemorySession("s1", "/tmp");
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );

  assert.equal(result, "done");
  const tool = session.messages.find((message: any) => message.role === "tool");
  assert.match(tool?.content ?? "", /"What should happen\?"="Build"/);
  assert.match(tool?.content ?? "", /"Which environment\?"="Dev"/);
});

test("a dismissed question records the result and stops the turn", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "q1",
          name: "question",
          arguments: {
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          },
        },
      ],
    },
    { text: "should not run" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: "/tmp",
    tools: [questionTool],
    questions: {
      handler: async () => ({ status: "cancelled" as const }),
      nonInteractive: false,
    },
  });
  const session = new InMemorySession("s1", "/tmp");
  const result = await runtime.runAgentTurn(
    "go",
    session,
    new AbortController().signal,
  );

  assert.equal(result, "");
  const tool = session.messages.find((message: any) => message.role === "tool");
  assert.equal(tool?.content, "The user dismissed this question");
  assert.equal(tool?.isError, true);
  assert.equal(
    session.messages.filter((message: any) => message.role === "assistant")
      .length,
    1,
  );
});

test("an aborted turn settles a pending question as dismissed", async () => {
  const controller = new AbortController();
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "q1",
          name: "question",
          arguments: {
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          },
        },
      ],
    },
    { text: "should not run" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: "/tmp",
    tools: [questionTool],
    questions: {
      handler: () =>
        new Promise(() => {
          // The client waits for input until the turn aborts.
        }),
      nonInteractive: false,
    },
  });
  const session = new InMemorySession("s1", "/tmp");
  const pending = runtime.runAgentTurn("go", session, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /USER_CANCELLED/);
});
