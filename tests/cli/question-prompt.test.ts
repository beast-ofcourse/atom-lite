import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionPromptView } from "../../dist/cli/question-prompt.js";
import { ansiTheme } from "../../dist/cli/theme.js";

function makeView(questions: any[]) {
  const outcomes: any[] = [];
  const view = new QuestionPromptView({
    questions,
    theme: ansiTheme,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { view, outcomes };
}

const single = [
  {
    question: "Pick one",
    header: "Pick",
    options: [
      { label: "Alpha", description: "First choice" },
      { label: "Beta", description: "Second choice" },
    ],
  },
];

test("question prompt renders title, options, descriptions and custom row", () => {
  const { view } = makeView(single);
  const text = view.render(80).join("\n");
  assert.match(text, /Questions/);
  assert.match(text, /Pick one/);
  assert.match(text, /1\. Alpha/);
  assert.match(text, /First choice/);
  assert.match(text, /2\. Beta/);
  assert.match(text, /3\. Type your own answer/);
  assert.match(text, /enter submit/);
  assert.match(text, /esc dismiss/);
});

test("number key on a single option question answers immediately", () => {
  const { view, outcomes } = makeView(single);
  view.handleInput("1");
  assert.deepEqual(outcomes, [{ status: "answered", answers: [["Alpha"]] }]);
});

test("enter picks the highlighted option", () => {
  const { view, outcomes } = makeView(single);
  view.handleInput("j");
  view.handleInput("\r");
  assert.deepEqual(outcomes, [{ status: "answered", answers: [["Beta"]] }]);
});

test("escape dismisses without an answer", () => {
  const { view, outcomes } = makeView(single);
  view.handleInput("\x1b");
  assert.deepEqual(outcomes, [{ status: "cancelled" }]);
});

test("multiselect toggles and submits from the review tab", () => {
  const { view, outcomes } = makeView([
    {
      question: "Select environments",
      header: "Environments",
      multiple: true,
      options: [
        { label: "Dev", description: "Development" },
        { label: "Prod", description: "Production" },
      ],
    },
  ]);
  view.handleInput("1");
  view.handleInput("2");
  const text = view.render(80).join("\n");
  assert.match(text, /\[✓\] Dev/);
  assert.match(text, /\[✓\] Prod/);
  view.handleInput("\t");
  view.handleInput("\r");
  assert.deepEqual(outcomes, [
    { status: "answered", answers: [["Dev", "Prod"]] },
  ]);
});

test("custom answer resolves a single option question", () => {
  const { view, outcomes } = makeView(single);
  view.handleInput("3");
  for (const char of "Gamma") view.handleInput(char);
  view.handleInput("\r");
  assert.deepEqual(outcomes, [{ status: "answered", answers: [["Gamma"]] }]);
});

test("escape closes the custom editor before dismissing", () => {
  const { view, outcomes } = makeView(single);
  view.handleInput("3");
  view.handleInput("x");
  view.handleInput("\x1b");
  assert.deepEqual(outcomes, []);
  view.handleInput("\x1b");
  assert.deepEqual(outcomes, [{ status: "cancelled" }]);
});

test("multiple questions advance and review before submit", () => {
  const { view, outcomes } = makeView([
    {
      question: "What?",
      header: "Action",
      options: [{ label: "Build", description: "Build it" }],
    },
    {
      question: "Where?",
      header: "Environment",
      options: [{ label: "Dev", description: "Development" }],
    },
  ]);
  view.handleInput("1");
  view.handleInput("1");
  const text = view.render(80).join("\n");
  assert.match(text, /Action: Build/);
  assert.match(text, /Environment: Dev/);
  view.handleInput("\r");
  assert.deepEqual(outcomes, [
    { status: "answered", answers: [["Build"], ["Dev"]] },
  ]);
});

test("free-text question edits directly and submits from review", () => {
  const { view, outcomes } = makeView([
    {
      question: "What is your name?",
      header: "Name",
      options: [],
    },
  ]);
  const text = view.render(80).join("\n");
  assert.match(text, /Type your answer/);
  for (const char of "Ada") view.handleInput(char);
  view.handleInput("\r");
  assert.deepEqual(outcomes, []);
  const review = view.render(80).join("\n");
  assert.match(review, /Name: Ada/);
  view.handleInput("\r");
  assert.deepEqual(outcomes, [{ status: "answered", answers: [["Ada"]] }]);
});

test("review shows unanswered questions", () => {
  const { view } = makeView([
    {
      question: "What?",
      header: "Action",
      options: [{ label: "Build", description: "Build it" }],
    },
    {
      question: "Where?",
      header: "Environment",
      options: [{ label: "Dev", description: "Development" }],
    },
  ]);
  view.handleInput("\t");
  view.handleInput("\t");
  const text = view.render(80).join("\n");
  assert.match(text, /Action: \(not answered\)/);
  assert.match(text, /Environment: \(not answered\)/);
});

test("tab commits a custom answer and moves exactly one field", () => {
  const { view } = makeView([
    {
      question: "First question",
      header: "First",
      options: [{ label: "Build", description: "Build it" }],
    },
    {
      question: "Second question",
      header: "Second",
      options: [{ label: "Dev", description: "Development" }],
    },
  ]);
  view.handleInput("2");
  view.handleInput("X");
  view.handleInput("\t");
  const text = view.render(80).join("\n");
  assert.match(text, /Second question/);
  assert.doesNotMatch(text, /First: X/);
});

test("every rendered line fits the requested width", () => {
  const { view } = makeView([
    {
      question:
        "A very long question that should wrap cleanly inside the prompt without ever exceeding the terminal width",
      header: "A rather long header label",
      options: [
        {
          label: "A long option label that also needs to fit",
          description:
            "A long description that wraps across multiple lines without exceeding the width",
        },
      ],
    },
  ]);
  for (const width of [24, 40, 60, 100]) {
    const lines = view.render(width);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `line width ${visibleWidth(line)} > ${width}: ${line}`,
      );
    }
  }
});
