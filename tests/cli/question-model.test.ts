import { test } from "node:test";
import assert from "node:assert/strict";
import {
  questionDisplay,
  questionIsSingle,
  questionSelected,
  questionSetCustom,
  questionToggle,
  questionValidate,
} from "../../dist/cli/question-model.js";

const question = {
  question: "Which environment?",
  header: "Environment",
  options: [
    { label: "Dev", description: "Development" },
    { label: "Prod", description: "Production" },
  ],
};

test("single only when there is one option question", () => {
  assert.equal(questionIsSingle([question]), true);
  assert.equal(questionIsSingle([{ ...question, multiple: true }]), false);
  assert.equal(questionIsSingle([{ ...question, options: [] }]), false);
  assert.equal(questionIsSingle([question, question]), false);
});

test("selected follows the configured label or the custom row", () => {
  assert.equal(questionSelected(question, undefined), 0);
  assert.equal(questionSelected(question, ["Prod"]), 1);
  assert.equal(questionSelected(question, ["Custom"]), 2);
  assert.equal(questionSelected(question, ["Dev", "Prod"]), 0);
});

test("toggle adds and removes without mutating the input", () => {
  const original = ["Dev"];
  assert.deepEqual(questionToggle(original, "Prod"), ["Dev", "Prod"]);
  assert.deepEqual(questionToggle(original, "Dev"), []);
  assert.deepEqual(original, ["Dev"]);
  assert.deepEqual(questionToggle(undefined, "Dev"), ["Dev"]);
});

test("custom replacement removes the previous answer once", () => {
  assert.deepEqual(questionSetCustom(["Dev", "old"], "old", "new"), [
    "Dev",
    "new",
  ]);
  assert.deepEqual(questionSetCustom(["Dev", "new"], "new", "new"), [
    "Dev",
    "new",
  ]);
  assert.deepEqual(questionSetCustom(["Dev", "old"], "old", ""), ["Dev"]);
  assert.deepEqual(questionSetCustom(undefined, undefined, "new"), ["new"]);
});

test("display joins labels and keeps custom values", () => {
  assert.equal(questionDisplay(question, ["Dev", "Prod"]), "Dev, Prod");
  assert.equal(questionDisplay(question, ["Custom"]), "Custom");
  assert.equal(questionDisplay(question, []), "");
  assert.equal(questionDisplay(question, [], "(none)"), "(none)");
});

test("validation allows unanswered questions and rejects empty answers", () => {
  assert.equal(questionValidate(question, undefined), undefined);
  assert.equal(questionValidate(question, []), undefined);
  assert.equal(questionValidate(question, ["Dev"]), undefined);
  assert.equal(questionValidate(question, ["Custom"]), undefined);
  assert.equal(questionValidate(question, [""]), "Answer cannot be empty");
});
