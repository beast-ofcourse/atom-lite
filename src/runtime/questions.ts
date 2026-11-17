/** User questions raised by a tool while a turn is running. */

export interface QuestionOption {
  /** Display text shown in the prompt. */
  label: string;
  /** Explanation rendered under the label. */
  description: string;
}

export interface QuestionPrompt {
  /** Complete question text. */
  question: string;
  /** Very short label used for the tab. */
  header: string;
  /** Available choices. Empty means a free-text question. */
  options: QuestionOption[];
  /** Allow selecting more than one choice. */
  multiple?: boolean;
}

export type QuestionAnswers = string[][];

export type QuestionOutcome =
  | { status: "answered"; answers: QuestionAnswers }
  | { status: "cancelled"; message?: string };

/**
 * Ask the active client a question. The handler blocks until the user answers,
 * dismisses the prompt, or the turn is aborted.
 */
export type QuestionHandler = (
  request: { questions: QuestionPrompt[] },
  signal?: AbortSignal,
) => Promise<QuestionOutcome>;

export interface QuestionContext {
  handler?: QuestionHandler;
  /** True when the client has no way to render an interactive prompt. */
  nonInteractive: boolean;
}

export const QUESTION_UNAVAILABLE =
  "Questions need an interactive terminal. Continue without asking, or explain what you need.";

/**
 * Resolve a question request through the injected handler.
 *
 * No handler and an aborted turn both settle as cancellations. A cancellation
 * without a message is a dismissal; the caller must not project it into model
 * output. A cancellation with a message is ordinary model-facing feedback.
 */
export async function askQuestion(
  ctx: QuestionContext | undefined,
  request: { questions: QuestionPrompt[] },
  signal?: AbortSignal,
): Promise<QuestionOutcome> {
  if (!ctx?.handler || ctx.nonInteractive) {
    return { status: "cancelled", message: QUESTION_UNAVAILABLE };
  }
  if (signal?.aborted) return { status: "cancelled" };

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<QuestionOutcome>((resolve) => {
    onAbort = () => resolve({ status: "cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([ctx.handler(request, signal), aborted]);
  } catch (error) {
    return {
      status: "cancelled",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
