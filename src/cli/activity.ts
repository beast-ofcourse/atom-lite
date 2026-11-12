import { darkTheme, type Theme } from "./theme.js";

export type ActivityPhase =
  "idle" | "formulating" | "thinking" | "working" | "waiting";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Verb pools keep the indicator lively without being distracting. */
export const ACTIVITY_VERBS: Record<
  Exclude<ActivityPhase, "idle" | "waiting">,
  string[]
> = {
  formulating: ["formulating", "planning", "lining things up"],
  thinking: ["thinking", "pondering", "reasoning", "mulling it over"],
  working: ["working", "cooking", "crafting", "building", "brewing"],
};

export interface ActivityOptions {
  now?: () => number;
  /** How often the spinner advances. */
  frameIntervalMs?: number;
  /** How often the verb rotates. */
  verbIntervalMs?: number;
  theme?: Theme;
  onChange?: () => void;
}

/** Format an elapsed duration compactly: 4s, 1m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const PHASE_COLOR: Record<
  Exclude<ActivityPhase, "idle" | "waiting">,
  "accent" | "warning"
> = {
  formulating: "warning",
  thinking: "warning",
  working: "accent",
};

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * Animated activity indicator. The app feeds it agent events and it produces a
 * single status line: idle, spinning with a rotating verb, or waiting for an
 * approval decision.
 */
export class Activity {
  private phase: ActivityPhase = "idle";
  private startedAt: number | null = null;
  private detail: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly frameIntervalMs: number;
  private readonly verbIntervalMs: number;
  private theme: Theme;
  private readonly onChange: () => void;

  constructor(options: ActivityOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.frameIntervalMs = Math.max(16, options.frameIntervalMs ?? 120);
    this.verbIntervalMs = Math.max(
      this.frameIntervalMs,
      options.verbIntervalMs ?? 2400,
    );
    this.theme = options.theme ?? darkTheme;
    this.onChange = options.onChange ?? (() => {});
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.onChange();
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  get elapsedMs(): number {
    if (this.phase === "idle" || this.startedAt === null) return 0;
    return Math.max(0, this.now() - this.startedAt);
  }

  /** Begin a new turn, resetting the elapsed timer. */
  start(
    phase: Exclude<ActivityPhase, "idle"> = "formulating",
    detail?: string,
  ): void {
    this.phase = phase;
    this.startedAt = this.now();
    this.detail = detail;
    this.ensureTimer();
    this.onChange();
  }

  /** Move to another phase without resetting the turn timer. */
  setPhase(phase: ActivityPhase, detail?: string): void {
    if (phase === "idle") {
      this.stop();
      return;
    }
    // bash emits setPhase per streamed chunk; skipping no-op transitions
    // keeps the timer semantics identical while avoiding redundant renders.
    if (this.phase === phase && this.detail === detail) {
      return;
    }
    if (this.phase === "idle" || this.startedAt === null) {
      this.startedAt = this.now();
    }
    this.phase = phase;
    this.detail = detail;
    if (phase === "waiting") {
      this.clearTimer();
    } else {
      this.ensureTimer();
    }
    this.onChange();
  }

  stop(): void {
    const wasActive = this.phase !== "idle";
    this.phase = "idle";
    this.detail = undefined;
    this.startedAt = null;
    this.clearTimer();
    if (wasActive) this.onChange();
  }

  /** Render the current state as a status-line fragment. */
  text(): string {
    const tokens = this.theme.tokens;
    if (this.phase === "idle") {
      return `${tokens.success("●")} ${tokens.dim("ready")}`;
    }
    if (this.phase === "waiting") {
      return `${tokens.warning("◉")} ${tokens.warning("Waiting for approval")} ${tokens.dim(
        "· y approve  n deny  t trust",
      )}`;
    }

    const elapsed = this.elapsedMs;
    const frame =
      SPINNER_FRAMES[
        Math.floor(elapsed / this.frameIntervalMs) % SPINNER_FRAMES.length
      ];
    const verbs = ACTIVITY_VERBS[this.phase];
    const verb =
      verbs[Math.floor(elapsed / this.verbIntervalMs) % verbs.length];
    const color = tokens[PHASE_COLOR[this.phase]];
    const detail = this.detail ? tokens.dim(` · ${this.detail}`) : "";
    return `${color(frame)} ${color(`${capitalize(verb)}…`)} ${tokens.dim(
      formatElapsed(elapsed),
    )}${detail}`;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.onChange(), this.frameIntervalMs);
    // Do not keep the process alive solely for the spinner.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
