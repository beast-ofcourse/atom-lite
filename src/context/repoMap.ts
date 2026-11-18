import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { estimateMessageTokens } from "./budget.js";

/** Stable header that identifies the injected repo map in model input. */
export const REPO_MAP_HEADER = "Repository map:";

/** Resolved repo-map settings. Config schema supplies these defaults. */
export interface RepoMapOptions {
  enabled: boolean;
  maxTokens: number;
  maxFiles: number;
}

/** Defaults used when no config has been wired into the context manager. */
export const DEFAULT_REPO_MAP_OPTIONS: RepoMapOptions = {
  enabled: true,
  maxTokens: 1200,
  maxFiles: 400,
};

/** Estimator shape shared with the context manager's token accounting. */
export type TokenEstimator = (message: unknown) => number;

/** Short note appended whenever any content is omitted from the map. */
const OMISSION_NOTE = "… (truncated, omitted)";

/** Tokens kept free so the final message stays inside the configured budget. */
const TOKEN_HEADROOM = 8;

/** Line-oriented declaration pattern for the TypeScript/JavaScript family. */
const TS_JS_DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Python declarations: plain and async functions plus classes. */
const PYTHON_DECLARATION = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

/** Go declarations: functions (including receiver methods) and types. */
const GO_DECLARATION =
  /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/;

/** Rust declarations, with optional visibility/qualifier prefixes and generics. */
const RUST_DECLARATION =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+)?(?:fn|struct|enum|trait|impl|mod)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/;

/** Generic declaration fallback for languages with no dedicated family. */
const GENERIC_DECLARATION =
  /^\s*(?:(?:public|private|protected|static|final|abstract|virtual|override|export|default|extern|inline|async|const|let|var|mut|open|sealed)\s+)*(?:function|func|fn|def|class|struct|enum|interface|trait|implementation|impl|module|mod|type|record|object|method|proc|procedure|subroutine|sub)\s+([A-Za-z_$][\w$]*)/;

const TS_JS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyw"]);
const GO_EXTENSIONS = new Set([".go"]);
const RUST_EXTENSIONS = new Set([".rs"]);

/** Languages with no dedicated family still get a partial map via the generic pattern. */
const GENERIC_EXTENSIONS = new Set([
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cs",
  ".vb",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  ".gradle",
  ".lua",
  ".pl",
  ".pm",
  ".r",
  ".ex",
  ".exs",
  ".erl",
  ".clj",
  ".cljs",
  ".hs",
  ".ml",
  ".mli",
  ".fs",
  ".fsx",
  ".dart",
  ".nim",
  ".zig",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
]);

const SOURCE_EXTENSIONS = new Set([
  ...TS_JS_EXTENSIONS,
  ...PYTHON_EXTENSIONS,
  ...GO_EXTENSIONS,
  ...RUST_EXTENSIONS,
  ...GENERIC_EXTENSIONS,
]);

/** Declaration pattern for a source file, keyed by its extension. */
function patternFor(rel: string): RegExp {
  const ext = extname(rel).toLowerCase();
  if (PYTHON_EXTENSIONS.has(ext)) return PYTHON_DECLARATION;
  if (GO_EXTENSIONS.has(ext)) return GO_DECLARATION;
  if (RUST_EXTENSIONS.has(ext)) return RUST_DECLARATION;
  if (TS_JS_EXTENSIONS.has(ext)) return TS_JS_DECLARATION;
  return GENERIC_DECLARATION;
}

/** One signature line never consumes more than this many characters. */
const MAX_SIGNATURE_CHARS = 200;

interface CachedMap {
  signature: string;
  text: string;
}

/** Process-lifetime cache, keyed by workspace so workspaces never bleed into each other. */
const cache = new Map<string, CachedMap>();

/** Drop every cached repo map so the next build rescans the workspace. */
export function clearRepoMapCache(): void {
  cache.clear();
}

/**
 * Build a compact, deterministic map of a workspace's source definitions
 * across the supported language families (TypeScript/JavaScript, Python, Go,
 * Rust) and a generic fallback. Returns an empty string when the feature is
 * disabled, the budget is zero, nothing is extractable, or on any
 * whole-pipeline failure, so callers need no special cases. Reads only; never
 * writes to the workspace and never contacts a provider.
 */
export function buildRepoMap(
  workspace: string,
  options: RepoMapOptions = DEFAULT_REPO_MAP_OPTIONS,
  estimate: TokenEstimator = estimateMessageTokens,
): string {
  try {
    if (!options.enabled || options.maxTokens <= 0) return "";
    const files = collectFiles(workspace, options.maxFiles);
    const signature = fileSignature(workspace, files, options);
    const cached = cache.get(workspace);
    if (cached && cached.signature === signature) return cached.text;
    const text = render(workspace, files, options.maxTokens, estimate);
    cache.set(workspace, { signature, text });
    return text;
  } catch {
    return "";
  }
}

function collectFiles(workspace: string, maxFiles: number): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(dir, entry.name), rel);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())
      ) {
        out.push(rel);
      }
    }
  };
  visit(workspace, "");
  const sorted = out.sort();
  return maxFiles >= sorted.length ? sorted : sorted.slice(0, maxFiles);
}

function fileSignature(
  workspace: string,
  files: string[],
  options: RepoMapOptions,
): string {
  return (
    workspace +
    "|" +
    `${options.enabled}:${options.maxTokens}:${options.maxFiles}` +
    "|" +
    files
      .map((rel) => {
        try {
          const st = statSync(join(workspace, rel));
          return `${rel}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${rel}:-`;
        }
      })
      .join("|")
  );
}

function cap(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_SIGNATURE_CHARS
    ? trimmed.slice(0, MAX_SIGNATURE_CHARS - 1) + "…"
    : trimmed;
}

/** One capped signature line per definition, grouped by file order. */
function definitionLines(workspace: string, files: string[]): string[] {
  const lines: string[] = [];
  for (const rel of files) {
    try {
      const source = readFileSync(join(workspace, rel), "utf8");
      const sourceLines = source.split(/\r?\n/);
      const declaration = patternFor(rel);
      const extracted: Array<{ line: number; signature: string }> = [];
      for (let i = 0; i < sourceLines.length; i++) {
        if (declaration.test(sourceLines[i])) {
          extracted.push({ line: i + 1, signature: sourceLines[i] });
        }
      }
      for (const def of extracted) {
        lines.push(`${rel}:${def.line}: ${cap(def.signature)}`);
      }
    } catch {
      // A single unreadable file is skipped; other definitions still appear.
    }
  }
  return lines;
}

/**
 * Fit the full rendering, then the largest truncated prefix that fits, then
 * degrade to a ranked file list. Budgeting measures the final system message
 * object so the reported size matches the context manager's accounting.
 */
function render(
  workspace: string,
  files: string[],
  maxTokens: number,
  estimate: TokenEstimator,
): string {
  const defs = definitionLines(workspace, files);
  if (defs.length === 0) return "";

  const budget = Math.max(0, maxTokens - TOKEN_HEADROOM);
  const joinLines = (lines: string[]): string => lines.join("\n");
  const fits = (lines: string[]): boolean =>
    estimate({ role: "system", content: joinLines(lines) }) <= budget;

  const full = [REPO_MAP_HEADER, ...defs];
  if (fits(full)) return joinLines(full);

  // Reserve room for the omission note before dropping definitions. If even
  // one definition plus the note cannot fit, fall back to file paths.
  const withNote = (count: number): string[] => [
    REPO_MAP_HEADER,
    ...defs.slice(0, count),
    OMISSION_NOTE,
  ];
  if (!fits(withNote(1))) return renderFileList(files, fits, joinLines);

  let lo = 1;
  let hi = defs.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(withNote(mid))) lo = mid;
    else hi = mid - 1;
  }
  return joinLines(withNote(lo));
}

/** Deterministically truncated ranked file list used when no definition fits. */
function renderFileList(
  files: string[],
  fits: (lines: string[]) => boolean,
  joinLines: (lines: string[]) => string,
): string {
  const paths = [...files];
  const lines = (): string[] => [REPO_MAP_HEADER, ...paths, OMISSION_NOTE];
  while (paths.length > 0 && !fits(lines())) paths.pop();
  return fits(lines()) ? joinLines(lines()) : "";
}
