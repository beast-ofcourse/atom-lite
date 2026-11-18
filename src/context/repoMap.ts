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
const GO_DECLARATION = /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/;

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

/** Files larger than this are skipped (generated bundles, checked-in data). */
const MAX_FILE_BYTES = 64 * 1024;

/** Short files with at most two non-empty lines are treated as minified. */
const MINIFIED_MIN_CHARS = 400;
const MINIFIED_MAX_LINES = 2;

/** Ranking score: base + weighted log of cross-file usage + high-signal boost. */
const RANK_BASE = 1;
const RANK_USAGE_WEIGHT = 1;
const HIGH_SIGNAL_BOOST = 1000;

/** Project instruction files are injected separately by the context manager. */
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

/** Directory names skipped anywhere in a workspace-relative path. */
const SKIP_DIRECTORIES = new Set([
  // dependencies
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "third-party",
  "external",
  "deps",
  "venv",
  "site-packages",
  "Pods",
  "Carthage",
  // build output
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  "__pycache__",
  "artifacts",
  "generated",
  // version control
  "CVS",
  // local application state and private scratch notes
  "scratch",
  "scratchpad",
  "tmp",
  "temp",
  "logs",
]);

/** True for a path inside a skipped directory or naming an instruction file. */
function isSkippedPath(rel: string): boolean {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].startsWith(".") || SKIP_DIRECTORIES.has(parts[i])) return true;
  }
  return INSTRUCTION_FILES.has(parts[parts.length - 1]);
}

/**
 * True for conventional entry points (readmes, manifests, build/compiler
 * configs, container definitions, CI configs). Definitions in these files get
 * a ranking boost so stack conventions surface early.
 */
function isHighSignal(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  if (/^readme(\.|$)/.test(lower)) return true;
  if (
    /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|setup\.(py|cfg)|requirements.*\.txt|pipfile(\.lock)?|gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.json|mix\.exs|pubspec\.yaml)$/.test(
      lower,
    )
  )
    return true;
  if (
    /^(tsconfig.*\.json|jsconfig.*\.json|makefile|cmakelists\.txt|dockerfile|docker-compose\..*|procfile|azure-pipelines\..*|gitlab-ci\..*|\.travis\..*)$/.test(
      lower,
    )
  )
    return true;
  return /\.config\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower);
}

/** Every identifier token in a file, including import/call usages. */
function identifierSet(source: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.add(match[0]);
  return out;
}

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
  // Order is established lexicographically (case-sensitive) before skip rules
  // and caps, so output never depends on filesystem enumeration order.
  const sorted = out.sort();
  const kept = sorted.filter((rel) => !isSkippedPath(rel));
  return maxFiles >= kept.length ? kept : kept.slice(0, maxFiles);
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

interface Definition {
  name: string;
  line: number;
  signature: string;
}

interface FileScan {
  rel: string;
  identifiers: Set<string>;
  definitions: Definition[];
  highSignal: boolean;
}

/** Read and extract one file. Any per-file failure yields null (skip it). */
function scanFile(workspace: string, rel: string): FileScan | null {
  try {
    const path = join(workspace, rel);
    const stat = statSync(path);
    if (
      !stat.isFile() ||
      stat.size > MAX_FILE_BYTES ||
      (stat.mode & 0o444) === 0
    )
      return null;
    const source = readFileSync(path, "utf8");
    if (source.includes("\0")) return null;
    const sourceLines = source.split(/\r?\n/);
    const nonEmpty = sourceLines.filter((line) => line.trim().length > 0);
    if (
      source.length > MINIFIED_MIN_CHARS &&
      nonEmpty.length <= MINIFIED_MAX_LINES
    )
      return null;
    const declaration = patternFor(rel);
    const definitions: Definition[] = [];
    for (let i = 0; i < sourceLines.length; i++) {
      const match = declaration.exec(sourceLines[i]);
      if (!match) continue;
      // Every declaration pattern captures the declaration name last.
      definitions.push({
        name: match[match.length - 1],
        line: i + 1,
        signature: sourceLines[i],
      });
    }
    return {
      rel,
      identifiers: identifierSet(source),
      definitions,
      highSignal: isHighSignal(rel),
    };
  } catch {
    // A single unreadable or malformed file is skipped; others still appear.
    return null;
  }
}

interface RankedDefinition extends Definition {
  path: string;
  score: number;
}

/** Deterministic order: score desc, then path asc, then line asc. */
function compareRanked(a: RankedDefinition, b: RankedDefinition): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
}

/**
 * Rank definitions by a usage-occurrence signal: the number of distinct
 * files whose identifier set contains the definition name, plus a boost for
 * high-signal project files. Ties break by path then line.
 */
function rankedDefinitions(
  workspace: string,
  files: string[],
): RankedDefinition[] {
  const scans = files
    .map((rel) => scanFile(workspace, rel))
    .filter(
      (scan): scan is FileScan => scan !== null && scan.definitions.length > 0,
    );

  const filesByName = new Map<string, number>();
  for (const scan of scans) {
    for (const name of scan.identifiers) {
      filesByName.set(name, (filesByName.get(name) ?? 0) + 1);
    }
  }

  const ranked: RankedDefinition[] = [];
  for (const scan of scans) {
    for (const def of scan.definitions) {
      const count = Math.max(1, filesByName.get(def.name) ?? 1);
      const score =
        RANK_BASE +
        RANK_USAGE_WEIGHT * Math.log(count) +
        (scan.highSignal ? HIGH_SIGNAL_BOOST : 0);
      ranked.push({ ...def, path: scan.rel, score });
    }
  }
  return ranked.sort(compareRanked);
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
  const ranked = rankedDefinitions(workspace, files);
  if (ranked.length === 0) return "";
  const defs = ranked.map(
    (def) => `${def.path}:${def.line}: ${cap(def.signature)}`,
  );

  // Files inherit their best definition's score; files without definitions
  // sort to the end, then path breaks the tie. The file-list fallback uses
  // the same ranking as the definition rendering.
  const bestByPath = new Map<string, number>();
  for (const def of ranked) {
    bestByPath.set(
      def.path,
      Math.max(bestByPath.get(def.path) ?? -Infinity, def.score),
    );
  }
  const rankedFiles = [...files].sort((a, b) => {
    const scoreA = bestByPath.get(a) ?? -Infinity;
    const scoreB = bestByPath.get(b) ?? -Infinity;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a < b ? -1 : a > b ? 1 : 0;
  });

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
  if (!fits(withNote(1))) return renderFileList(rankedFiles, fits, joinLines);

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
