import type { QuestionPrompt } from "../runtime/questions.js";

/** One selectable row in the question prompt. */
export interface QuestionRow {
  value: string;
  label: string;
  description?: string;
}

/** True when the answer is a plain selection from the configured options. */
export function questionHasOptions(question: QuestionPrompt): boolean {
  return question.options.length > 0;
}

/**
 * A single option question skips the tab bar and submits on pick. A single
 * free-text question still gets a field page plus a Submit page, matching
 * OpenCode's form behavior.
 */
export function questionIsSingle(
  questions: readonly QuestionPrompt[],
): boolean {
  if (questions.length !== 1) return false;
  const question = questions[0];
  return question.multiple !== true && questionHasOptions(question);
}

export function questionRows(question: QuestionPrompt): QuestionRow[] {
  return question.options.map((option) => ({
    value: option.label,
    label: option.label,
    description: option.description,
  }));
}

/** Initial row highlighted for a question, given its current answer. */
export function questionSelected(
  question: QuestionPrompt,
  value: string[] | undefined,
): number {
  if (!value || value.length !== 1) return 0;
  const index = question.options.findIndex(
    (option) => option.label === value[0],
  );
  return index === -1 ? questionRows(question).length : index;
}

/** Add or remove one option label, returning a new array. */
export function questionToggle(
  value: string[] | undefined,
  label: string,
): string[] {
  const current = value ?? [];
  const index = current.indexOf(label);
  if (index === -1) return [...current, label];
  return [...current.slice(0, index), ...current.slice(index + 1)];
}

/**
 * Replace the previous custom answer with the next one. An empty next value
 * only removes the previous entry, so clearing the editor clears the answer.
 */
export function questionSetCustom(
  value: string[] | undefined,
  previous: string | undefined,
  next: string,
): string[] {
  const current = previous
    ? (value ?? []).filter((item) => item !== previous)
    : [...(value ?? [])];
  if (next && !current.includes(next)) current.push(next);
  return current;
}

/** Human-readable answer used by the review page and the prompt row. */
export function questionDisplay(
  question: QuestionPrompt,
  value: string[] | undefined,
  empty = "",
): string {
  if (!value || value.length === 0) return empty;
  return value
    .map(
      (item) =>
        question.options.find((option) => option.label === item)?.label ?? item,
    )
    .join(", ");
}

/**
 * Validate one answer. Questions are optional, so an absent answer is valid.
 * Custom answers are always allowed; only malformed values are rejected.
 */
export function questionValidate(
  _question: QuestionPrompt,
  value: string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "Expected selections";
  if (value.some((item) => typeof item !== "string"))
    return "Expected selections";
  if (value.some((item) => item.trim().length === 0)) {
    return "Answer cannot be empty";
  }
  return undefined;
}
