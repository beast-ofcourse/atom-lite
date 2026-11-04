/**
 * Semantic theme tokens for the TUI.
 *
 * Components ask for a token (for example `theme.dim`) instead of hardcoding
 * ANSI escapes. That keeps the light, dark, and no-colour variants consistent
 * and makes the choice testable without asserting on raw escape sequences.
 */

export type ThemeMode = "dark" | "light" | "ansi";

export type ThemeToken =
  | "text"
  | "dim"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "border"
  | "selection"
  | "status"
  | "banner"
  | "heading"
  | "link"
  | "code"
  | "quote"
  | "diffAdded"
  | "diffRemoved"
  | "diffContext"
  | "approval";

export type ThemeStyle = (text: string) => string;

export interface Theme {
  /** Name recorded in config (never "auto"; auto resolves to dark/light). */
  readonly name: ThemeMode;
  readonly mode: ThemeMode;
  readonly tokens: Record<ThemeToken, ThemeStyle>;
}

export interface ThemeOptions {
  /** CLI --no-color or a caller-forced no-colour session. */
  noColor?: boolean;
  /** Environment to inspect for NO_COLOR and COLORFGBG. */
  env?: NodeJS.ProcessEnv;
  /** A colour-scheme report from the terminal, when available. */
  scheme?: "dark" | "light";
}

const RESET = "\x1b[0m";

function sgr(params: string): ThemeStyle {
  return (text) => (text ? `\x1b[${params}m${text}${RESET}` : text);
}

const identity: ThemeStyle = (text) => text;

function tokens(
  overrides: Partial<Record<ThemeToken, ThemeStyle>>,
): Record<ThemeToken, ThemeStyle> {
  const base: Record<ThemeToken, ThemeStyle> = {
    text: identity,
    dim: sgr("2"),
    accent: sgr("36"),
    success: sgr("32"),
    warning: sgr("33"),
    error: sgr("31"),
    border: sgr("90"),
    selection: sgr("7"),
    status: sgr("2"),
    banner: sgr("1;31"),
    heading: sgr("1"),
    link: sgr("4;36"),
    code: sgr("36"),
    quote: sgr("2;3"),
    diffAdded: sgr("32"),
    diffRemoved: sgr("31"),
    diffContext: sgr("90"),
    approval: sgr("33"),
  };
  return { ...base, ...overrides };
}

export const darkTheme: Theme = {
  name: "dark",
  mode: "dark",
  tokens: tokens({}),
};

/**
 * Dark variants for foreground colours. Standard-bright colours wash out on a
 * light background, so this theme deliberately sticks to the 30-37/90 range.
 */
export const lightTheme: Theme = {
  name: "light",
  mode: "light",
  tokens: tokens({
    accent: sgr("34"),
    border: sgr("90"),
    status: sgr("90"),
    banner: sgr("1;35"),
    link: sgr("4;34"),
    code: sgr("34"),
    quote: sgr("3"),
  }),
};

/** Terminal-palette/no-colour theme: every token is the identity function. */
export const ansiTheme: Theme = {
  name: "ansi",
  mode: "ansi",
  tokens: tokens({
    text: identity,
    dim: identity,
    accent: identity,
    success: identity,
    warning: identity,
    error: identity,
    border: identity,
    selection: identity,
    status: identity,
    banner: identity,
    heading: identity,
    link: identity,
    code: identity,
    quote: identity,
    diffAdded: identity,
    diffRemoved: identity,
    diffContext: identity,
    approval: identity,
  }),
};

/** Names shown in the /theme picker, including the auto sentinel. */
export function themeNames(): string[] {
  return ["auto", "dark", "light", "ansi"];
}

/** NO_COLOR is honoured when it is present and non-empty (per no-color.org). */
export function isNoColorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return typeof env.NO_COLOR === "string" && env.NO_COLOR.length > 0;
}

/**
 * Best-effort background detection from COLORFGBG. The final field is the
 * background palette index: 7 (white) and 9-15 (bright) are light, the rest
 * are dark.
 */
export function detectColorScheme(
  env: NodeJS.ProcessEnv = process.env,
): "dark" | "light" | undefined {
  const raw = env.COLORFGBG;
  if (!raw) return undefined;
  const fields = raw.split(";").filter((part) => part.length > 0);
  const background = Number.parseInt(fields[fields.length - 1] ?? "", 10);
  if (!Number.isFinite(background)) return undefined;
  return background === 7 || background >= 9 ? "light" : "dark";
}

export function resolveThemeName(
  name: string,
  options: ThemeOptions = {},
): "dark" | "light" | "ansi" {
  if (options.noColor || isNoColorEnabled(options.env)) return "ansi";
  if (name === "ansi") return "ansi";
  if (name === "light") return "light";
  if (name === "dark") return "dark";
  // Unknown custom names are not loadable yet; keep the safe default.
  if (name !== "auto") return "dark";
  return options.scheme ?? detectColorScheme(options.env) ?? "dark";
}

export function resolveTheme(name: string, options: ThemeOptions = {}): Theme {
  const resolved = resolveThemeName(name, options);
  if (resolved === "light") return lightTheme;
  if (resolved === "ansi") return ansiTheme;
  return darkTheme;
}

/** Human-readable label for a configured theme name. */
export function themeLabel(name: string): string {
  if (name === "auto") return "auto (detect)";
  if (name === "ansi") return "ansi (no colour)";
  return name;
}
