import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  QuestionOutcome,
  QuestionPrompt as QuestionSpec,
} from "../runtime/questions.js";
import { darkTheme, type Theme } from "./theme.js";
import { extractPaste } from "./input.js";
import { bold } from "./panel.js";
import {
  questionDisplay,
  questionRows,
  questionSelected,
  questionSetCustom,
  questionToggle,
  questionValidate,
} from "./question-model.js";

const TITLE = "Questions";
const CUSTOM_LABEL = "Type your own answer";
const REVIEW_WINDOW = 8;

export interface QuestionPromptOptions {
  questions: QuestionSpec[];
  theme?: Theme;
  onOutcome: (outcome: QuestionOutcome) => void;
}

function printable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  return data.length === 1 ? data : undefined;
}

function isChar(data: string, char: string): boolean {
  return printable(data)?.toLowerCase() === char;
}

/**
 * The interactive question prompt. Mirrors OpenCode's form prompt: tabs for
 * multiple questions, numbered options with descriptions, a custom answer row,
 * multiselect toggling, and a review page before submit.
 */
export class QuestionPromptView implements Component {
  private readonly questions: QuestionSpec[];
  private readonly theme: Theme;
  private readonly onOutcome: (outcome: QuestionOutcome) => void;
  private readonly answers: (string[] | undefined)[];
  private readonly custom: (string | undefined)[];
  private tab = 0;
  private selected = 0;
  private editing = false;
  private input = "";
  private cursor = 0;
  private error = "";
  private reviewScroll = 0;
  private settled = false;

  constructor(options: QuestionPromptOptions) {
    this.questions = options.questions;
    this.theme = options.theme ?? darkTheme;
    this.onOutcome = options.onOutcome;
    this.answers = this.questions.map(() => undefined);
    this.custom = this.questions.map(() => undefined);
    this.selected = questionSelected(this.questions[0], undefined);
  }

  invalidate(): void {
    // Rendering is cheap and derived from current state; nothing to cache.
  }

  private get single(): boolean {
    return (
      this.questions.length === 1 &&
      this.questions[0]?.multiple !== true &&
      (this.questions[0]?.options.length ?? 0) > 0
    );
  }

  private get tabs(): number {
    return this.single ? 1 : this.questions.length + 1;
  }

  private get confirm(): boolean {
    return !this.single && this.tab >= this.questions.length;
  }

  private current(): QuestionSpec | undefined {
    return this.confirm ? undefined : this.questions[this.tab];
  }

  private get multi(): boolean {
    return this.current()?.multiple === true;
  }

  private get textual(): boolean {
    const question = this.current();
    return question !== undefined && question.options.length === 0;
  }

  private rows() {
    const question = this.current();
    return question ? questionRows(question) : [];
  }

  private totalRows(): number {
    return this.rows().length + 1;
  }

  private value(): string[] | undefined {
    return this.answers[this.tab];
  }

  private customPicked(): boolean {
    const question = this.current();
    if (!question) return false;
    return (this.value() ?? []).some(
      (item) => !question.options.some((option) => option.label === item),
    );
  }

  private go(index: number): void {
    this.tab = (index + this.tabs) % this.tabs;
    this.editing = false;
    this.error = "";
    this.input = "";
    this.cursor = 0;
    this.reviewScroll = 0;
    this.selected =
      this.tab < this.questions.length
        ? questionSelected(this.questions[this.tab], this.answers[this.tab])
        : 0;
  }

  private reply(): void {
    if (this.settled) return;
    this.settled = true;
    this.onOutcome({
      status: "answered",
      answers: this.questions.map((_, index) => [
        ...(this.answers[index] ?? []),
      ]),
    });
  }

  private dismiss(): void {
    if (this.settled) return;
    this.settled = true;
    this.onOutcome({ status: "cancelled" });
  }

  private submit(): void {
    for (let index = 0; index < this.questions.length; index++) {
      const invalid = questionValidate(
        this.questions[index],
        this.answers[index],
      );
      if (invalid) {
        this.tab = index;
        this.error = invalid;
        this.selected = questionSelected(
          this.questions[index],
          this.answers[index],
        );
        return;
      }
    }
    this.reply();
  }

  private selectRow(index: number): void {
    const question = this.current();
    if (!question) return;
    const rows = this.rows();
    if (index === rows.length) {
      this.beginCustom();
      return;
    }
    const row = rows[index];
    if (!row) return;
    if (this.multi) {
      this.answers[this.tab] = questionToggle(this.value(), row.value);
      this.error = "";
      return;
    }
    this.answers[this.tab] = [row.value];
    this.error = "";
    if (this.single) {
      this.reply();
      return;
    }
    this.go(this.tab + 1);
  }

  private beginCustom(): void {
    this.editing = true;
    this.input = this.custom[this.tab] ?? "";
    this.cursor = this.input.length;
    this.error = "";
  }

  private syncCustom(): void {
    const question = this.current();
    if (!question) return;
    const previous = this.custom[this.tab];
    const text = this.input.trim();
    this.custom[this.tab] = text || undefined;
    if (this.multi) {
      this.answers[this.tab] = questionSetCustom(this.value(), previous, text);
    } else {
      this.answers[this.tab] = text ? [text] : undefined;
    }
  }

  private commitCustom(): "stay" | "advance" | "settled" {
    this.syncCustom();
    this.editing = false;
    this.error = "";
    if (this.multi) return "stay";
    if (this.single) {
      this.reply();
      return "settled";
    }
    return "advance";
  }

  private insertText(text: string): void {
    if (!text) return;
    this.input =
      this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
    this.syncCustom();
  }

  private deleteBefore(): void {
    if (this.cursor === 0) return;
    this.input =
      this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
    this.cursor--;
    this.syncCustom();
  }

  private deleteAt(): void {
    if (this.cursor >= this.input.length) return;
    this.input =
      this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
    this.syncCustom();
  }

  private editInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.dismiss();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.textual) {
        this.dismiss();
        return;
      }
      this.editing = false;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const next = this.commitCustom();
      if (next === "advance") this.go(this.tab + 1);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      const next = this.commitCustom();
      if (next !== "settled") this.go(this.tab + 1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      const next = this.commitCustom();
      if (next !== "settled") this.go(this.tab - 1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.editing = false;
      this.selected = (this.selected - 1 + this.totalRows()) % this.totalRows();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.deleteBefore();
      return;
    }
    if (matchesKey(data, Key.delete)) {
      this.deleteAt();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(this.input.length, this.cursor + 1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.cursor = this.input.length;
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      if (this.input.length === 0) {
        this.editing = false;
        return;
      }
      this.input = "";
      this.cursor = 0;
      this.syncCustom();
      return;
    }

    const paste = extractPaste(data);
    if (paste !== null) {
      this.insertText(paste.replace(/\r\n?/g, "\n").replace(/\s+/g, " "));
      return;
    }
    const char = printable(data);
    if (char !== undefined && !/[\x00-\x1f\x7f]/.test(char)) {
      this.insertText(char);
    }
  }

  private reviewInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      this.dismiss();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submit();
      return;
    }
    const max = Math.max(0, this.questions.length - REVIEW_WINDOW);
    if (matchesKey(data, Key.up) || isChar(data, "k")) {
      this.reviewScroll = Math.max(0, this.reviewScroll - 1);
      return;
    }
    if (matchesKey(data, Key.down) || isChar(data, "j")) {
      this.reviewScroll = Math.min(max, this.reviewScroll + 1);
    }
  }

  handleInput(data: string): void {
    if (this.settled || isKeyRelease(data)) return;
    if (this.textual && !this.confirm) {
      this.editInput(data);
      return;
    }
    if (this.editing) {
      this.editInput(data);
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      this.dismiss();
      return;
    }
    if (this.confirm) {
      this.reviewInput(data);
      return;
    }

    if (matchesKey(data, Key.left) || isChar(data, "h")) {
      this.go(this.tab - 1);
      return;
    }
    if (matchesKey(data, Key.right) || isChar(data, "l")) {
      this.go(this.tab + 1);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.go(this.tab + 1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.go(this.tab - 1);
      return;
    }
    if (matchesKey(data, Key.up) || isChar(data, "k")) {
      this.selected = (this.selected - 1 + this.totalRows()) % this.totalRows();
      return;
    }
    if (matchesKey(data, Key.down) || isChar(data, "j")) {
      this.selected = (this.selected + 1) % this.totalRows();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectRow(this.selected);
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (this.multi) this.selectRow(this.selected);
      return;
    }

    const char = printable(data);
    if (char !== undefined && /^[1-9]$/.test(char)) {
      const index = Number(char) - 1;
      if (index < this.totalRows()) {
        this.selected = index;
        this.selectRow(index);
      }
    }
  }

  private actionLabel(): string {
    if (this.confirm) return "submit";
    if (this.multi) {
      if (this.selected === this.rows().length && this.editing) return "done";
      if (this.selected === this.rows().length && !this.custom[this.tab]) {
        return "edit";
      }
      return "toggle";
    }
    if (this.single) return "submit";
    return "confirm";
  }

  private renderInput(max: number, placeholder = CUSTOM_LABEL): string {
    if (this.input.length === 0) {
      return (
        this.theme.tokens.dim(placeholder) + this.theme.tokens.selection(" ")
      );
    }
    let start = 0;
    while (
      start < this.cursor &&
      visibleWidth(this.input.slice(start, this.cursor)) > Math.max(1, max - 1)
    ) {
      start++;
    }
    const before = this.input.slice(start, this.cursor);
    const at = this.input.slice(this.cursor, this.cursor + 1) || " ";
    const after = this.input.slice(this.cursor + 1);
    const room = Math.max(1, max - visibleWidth(before) - 1);
    return (
      before +
      this.theme.tokens.selection(at) +
      truncateToWidth(after, room, "…")
    );
  }

  render(width: number): string[] {
    const w = Math.max(24, Math.floor(width));
    const inner = Math.max(8, w - 2);
    const bar = this.theme.tokens.accent("│ ");
    const lines: string[] = [];
    const push = (text: string): void => {
      lines.push(bar + text);
    };
    const pushWrapped = (
      text: string,
      style: (value: string) => string = this.theme.tokens.text,
    ): void => {
      const wrapped = wrapTextWithAnsi(text, inner);
      if (wrapped.length === 0) push(style(""));
      else for (const line of wrapped) push(style(line));
    };

    push(this.theme.tokens.dim(TITLE));

    if (!this.single) {
      push("");
      const labels = [
        ...this.questions.map((question) =>
          truncateToWidth(question.header || question.question, 24, "…"),
        ),
        "Submit",
      ];
      const tabWidth = labels.reduce(
        (sum, label) => sum + visibleWidth(label) + 2,
        0,
      );
      if (tabWidth <= inner) {
        push(
          labels
            .map((label, index) => {
              if (index === this.tab)
                return bold(this.theme.tokens.text(label));
              return this.theme.tokens.dim(label);
            })
            .join("  "),
        );
      } else {
        const answered = this.answers.filter(
          (answer) => (answer?.length ?? 0) > 0,
        ).length;
        push(
          this.theme.tokens.dim(
            `Field ${Math.min(this.tab, this.questions.length - 1) + 1} of ${this.questions.length}`,
          ) +
            this.theme.tokens.dim(
              ` · ${answered}/${this.questions.length} completed`,
            ),
        );
      }
    }

    push("");

    if (this.confirm) {
      const end = Math.min(
        this.questions.length,
        this.reviewScroll + REVIEW_WINDOW,
      );
      for (let index = this.reviewScroll; index < end; index++) {
        const question = this.questions[index];
        const value = questionDisplay(question, this.answers[index]);
        const answered = (this.answers[index]?.length ?? 0) > 0;
        const prefix = `${truncateToWidth(question.header || question.question, 24, "…")}: `;
        const room = Math.max(4, inner - visibleWidth(prefix));
        const shown = truncateToWidth(
          answered ? value : "(not answered)",
          room,
          "…",
        );
        push(
          this.theme.tokens.dim(prefix) +
            (answered
              ? this.theme.tokens.text(shown)
              : this.theme.tokens.error(shown)),
        );
      }
      if (this.questions.length > REVIEW_WINDOW) {
        push(
          this.theme.tokens.dim(
            `(${this.reviewScroll + 1}-${end} of ${this.questions.length})`,
          ),
        );
      }
    } else {
      const question = this.current();
      if (question) {
        pushWrapped(question.question);
        push("");
        if (question.options.length === 0) {
          push(
            `  ${this.renderInput(Math.max(4, inner - 2), "Type your answer")}`,
          );
        } else {
          const value = this.value();
          const rows = this.rows();
          rows.forEach((row, index) => {
            const active = this.selected === index;
            const picked = (value ?? []).includes(row.value);
            const number = `${index + 1}.`;
            const checkbox = question.multiple
              ? `[${picked ? "✓" : " "}] `
              : "";
            const labelText = truncateToWidth(
              row.label,
              Math.max(4, inner - 6),
              "…",
            );
            const label = active
              ? this.theme.tokens.accent(labelText)
              : picked
                ? this.theme.tokens.success(labelText)
                : this.theme.tokens.text(labelText);
            const check =
              !question.multiple && picked
                ? this.theme.tokens.success(" ✓")
                : "";
            push(
              `${active ? this.theme.tokens.accent(number) : this.theme.tokens.dim(number)} ${checkbox}${label}${check}`,
            );
            if (row.description && row.description.trim()) {
              for (const line of wrapTextWithAnsi(
                row.description,
                Math.max(4, inner - 3),
              )) {
                push(`   ${this.theme.tokens.dim(line)}`);
              }
            }
          });

          const customIndex = rows.length;
          const active = this.selected === customIndex;
          const number = `${customIndex + 1}.`;
          if (this.editing) {
            push(
              `${active ? this.theme.tokens.accent(number) : this.theme.tokens.dim(number)} ${this.renderInput(Math.max(4, inner - 4))}`,
            );
          } else {
            const checkbox = question.multiple
              ? `[${this.customPicked() ? "✓" : " "}] `
              : "";
            const text = truncateToWidth(
              this.custom[this.tab] || CUSTOM_LABEL,
              Math.max(4, inner - 6),
              "…",
            );
            const styled = active
              ? this.theme.tokens.accent(text)
              : this.customPicked()
                ? this.theme.tokens.success(text)
                : this.theme.tokens.text(text);
            const check =
              !question.multiple && this.customPicked()
                ? this.theme.tokens.success(" ✓")
                : "";
            push(
              `${active ? this.theme.tokens.accent(number) : this.theme.tokens.dim(number)} ${checkbox}${styled}${check}`,
            );
          }
        }
      }
    }

    push("");
    const hints: string[] = [];
    if (!this.single) hints.push("⇆ tab");
    if (!this.confirm && !this.textual && !this.editing) {
      hints.push("↑↓ select");
    }
    hints.push(`enter ${this.actionLabel()}`);
    hints.push(`esc ${this.editing && !this.textual ? "close" : "dismiss"}`);
    for (const line of wrapTextWithAnsi(hints.join("  "), inner)) {
      push(this.theme.tokens.dim(line));
    }
    if (this.error) {
      for (const line of wrapTextWithAnsi(this.error, inner)) {
        push(this.theme.tokens.error(line));
      }
    }
    return lines;
  }
}
