import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { estimateMessageTokens } from "../../dist/context/budget.js";
import {
  buildRepoMap,
  DEFAULT_REPO_MAP_OPTIONS,
  type RepoMapOptions,
} from "../../dist/context/repoMap.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

const HEADER = "Repository map:";

function settings(overrides: Partial<RepoMapOptions> = {}): RepoMapOptions {
  return { enabled: true, maxTokens: 1200, maxFiles: 400, ...overrides };
}

function stubProvider(): any {
  return {
    id: "fake",
    generate: async () => ({
      message: {
        role: "assistant",
        content: [{ type: "text", text: VALID_SUMMARY }],
      },
      toolCalls: [],
      finishReason: "stop",
    }),
  };
}

function manager(
  dir: string,
  repoMap: RepoMapOptions = settings(),
): ContextManager {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 100,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: stubProvider(),
    model: "test",
    userInstructionsPath: join(dir, "user-AGENTS.md"),
    repoMap,
  });
}

function mapText(messages: any[]): string {
  const found = messages.find(
    (m) => typeof m.content === "string" && m.content.startsWith(HEADER),
  );
  return found ? found.content : "";
}

// Reason: the map must stay out of model input unless the user opts in.
test("the repo map is off by default", () => {
  assert.equal(DEFAULT_REPO_MAP_OPTIONS.enabled, false);
  const dir = mkdtempSync(join(tmpdir(), "atom-"));
  writeFileSync(join(dir, "a.ts"), "export function a() {}\n");
  assert.equal(buildRepoMap(dir), "");
});

// Reason: spec (lines 15-16, 78) — definitions carry workspace-relative path, line number, and a signature line; bodies are excluded.
test("TypeScript and JavaScript definitions appear with path, line number, and signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-"));
  writeFileSync(
    join(dir, "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export class Calc {}",
    ].join("\n"),
  );
  writeFileSync(join(dir, "util.js"), "const noop = () => {};\n");

  const messages = await manager(dir).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /^Repository map:/);
  assert.match(map, /math\.ts:1: export function add\(a: number, b: number\)/);
  assert.match(map, /math\.ts:4: export class Calc/);
  assert.match(map, /util\.js:1: const noop/);
  assert.doesNotMatch(map, /return a \+ b/);
});

// Reason: spec (lines 5-6, 25, 84-86) — unchanged workspaces reuse cached text byte-for-byte; an edit invalidates it.
test("unchanged files give byte-identical map text; an edit changes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-cache-"));
  const file = join(dir, "api.ts");
  writeFileSync(file, "export function alpha() {}\n");
  const cm = manager(dir);
  const first = await cm.build(dir, []);

  const second = await cm.build(dir, []);
  assert.equal(mapText(second), mapText(first));

  writeFileSync(file, "export function charlie() {}\n");
  const third = await cm.build(dir, []);
  assert.match(mapText(third), /charlie/);
  assert.doesNotMatch(mapText(third), /alpha/);
});

// Reason: spec (line 86, further notes line 149) — cache signature is path plus mtime plus size.
test("the cache key uses modification time and size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-signature-"));
  const file = join(dir, "api.ts");
  writeFileSync(file, "export function alpha() {}\n");
  const cm = manager(dir);
  assert.match(mapText(await cm.build(dir, [])), /alpha/);

  // Same size, newer mtime: the edit must be detected.
  writeFileSync(file, "export function bravo() {}\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
  assert.match(mapText(await cm.build(dir, [])), /bravo/);

  // Same mtime, different size: the edit must also be detected.
  writeFileSync(file, "export function delta() { extra }\n");
  utimesSync(file, future, future);
  assert.match(mapText(await cm.build(dir, [])), /delta/);
});

// Reason: spec (line 86) — the context manager's invalidation entry point clears the repo-map cache.
test("invalidateCaches clears the module cache on an unchanged signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-clear-"));
  const file = join(dir, "api.ts");
  writeFileSync(file, "export function alpha() {}\n");
  const cm = manager(dir);
  assert.match(mapText(await cm.build(dir, [])), /alpha/);
  const mtimeSeconds = statSync(file).mtimeMs / 1000;

  // Same size and same mtime: the signature still matches, so the cached
  // (now stale) text is reused rather than rescanned.
  writeFileSync(file, "export function bravo() {}\n");
  utimesSync(file, mtimeSeconds, mtimeSeconds);
  assert.match(mapText(await cm.build(dir, [])), /alpha/);

  cm.invalidateCaches();
  assert.match(mapText(await cm.build(dir, [])), /bravo/);
});

// Reason: spec (solution line 15) — no definitions yields no map, so callers need no special case.
test("a workspace with no extractable definitions produces no map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-empty-"));
  writeFileSync(join(dir, "notes.txt"), "export function add(a) {}\n");
  writeFileSync(join(dir, "empty.js"), "// nothing to declare here\ncall();\n");
  assert.equal(mapText(await manager(dir).build(dir, [])), "");
});

// Reason: spec (lines 8, 84) — the same map text is injected in the compacted build.
test("the map survives compaction with identical text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-compaction-"));
  writeFileSync(
    join(dir, "math.ts"),
    "export function add(a: number) { return a; }\n",
  );
  const cm = manager(dir);
  const history: any[] = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${i}` }],
  }));

  const before = mapText(await cm.build(dir, history));
  assert.match(before, /add/);
  cm.setForceCompact(true);
  const after = mapText(await cm.build(dir, history));
  assert.equal(after, before);
});

// Reason: spec (lines 45, 85) — compaction pressure is computed from the true model input including the map.
test("the map is included in token accounting used for compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-tokens-"));
  const file = join(dir, "api.ts");
  writeFileSync(
    file,
    "export function alpha() {}\nexport function bravo() {}\nexport function charlie() {}\n",
  );
  const cm = manager(dir);
  const withMap = await cm.build(dir, []);
  const tokensWithMap = cm.getLastBuildTokens();
  assert.ok(mapText(withMap));
  assert.ok(tokensWithMap > 0);

  unlinkSync(file);
  cm.invalidateCaches();
  const withoutMap = await cm.build(dir, []);
  assert.equal(mapText(withoutMap), "");
  assert.ok(cm.getLastBuildTokens() < tokensWithMap);
});

// Reason: spec (line 17) — Python functions and classes are extracted.
test("Python class and function declarations appear with path, line number, and signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-py-"));
  writeFileSync(
    join(dir, "models.py"),
    [
      "class User:",
      "    pass",
      "",
      "def get_user(id):",
      "    return None",
      "",
      "async def async_fetch(url):",
      "    pass",
    ].join("\n"),
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /^Repository map:/);
  assert.match(map, /models\.py:1: class User/);
  assert.match(map, /models\.py:4: def get_user/);
  assert.match(map, /models\.py:7: async def async_fetch/);
  assert.doesNotMatch(map, /return None/);
});

// Reason: spec (line 18) — Go functions and types are extracted.
test("Go function and type declarations appear with path, line number, and signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-go-"));
  writeFileSync(
    join(dir, "server.go"),
    [
      "package main",
      "",
      "type Server struct {",
      "    Addr string",
      "}",
      "",
      "func NewServer(addr string) *Server {",
      "    return &Server{Addr: addr}",
      "}",
      "",
      "func (s *Server) Start() error {",
      "    return nil",
      "}",
    ].join("\n"),
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /^Repository map:/);
  assert.match(map, /server\.go:3: type Server struct/);
  assert.match(map, /server\.go:7: func NewServer/);
  assert.match(map, /server\.go:11: func \(s \*Server\) Start/);
  assert.doesNotMatch(map, /return &Server/);
});

// Reason: spec (line 19) — Rust declarations are extracted.
test("Rust function, struct, enum, trait, impl, and module declarations appear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-rs-"));
  writeFileSync(
    join(dir, "lib.rs"),
    [
      "pub mod net;",
      "",
      "pub struct Config {",
      "    pub host: String,",
      "}",
      "",
      "pub enum Status {",
      "    Ok,",
      "    Err,",
      "}",
      "",
      "pub trait Runnable {",
      "    fn run(&self);",
      "}",
      "",
      "impl Config {",
      "    pub fn new() -> Self {",
      "        Self { host: String::new() }",
      "    }",
      "}",
      "",
      "fn helper() {}",
    ].join("\n"),
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /^Repository map:/);
  assert.match(map, /lib\.rs:1: pub mod net/);
  assert.match(map, /lib\.rs:3: pub struct Config/);
  assert.match(map, /lib\.rs:7: pub enum Status/);
  assert.match(map, /lib\.rs:12: pub trait Runnable/);
  assert.match(map, /lib\.rs:16: impl Config/);
  assert.match(map, /lib\.rs:17: pub fn new/);
  assert.match(map, /lib\.rs:22: fn helper/);
  assert.doesNotMatch(map, /host: String::new/);
});

// Reason: spec (line 20) — unknown languages still get a partial map via the generic pattern.
test("unsupported languages produce a partial map from the generic fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-generic-"));
  writeFileSync(
    join(dir, "Widget.java"),
    [
      "package ui;",
      "",
      "public class Widget {",
      "    private String label;",
      "",
      "    public void render() {",
      "        System.out.println(label);",
      "    }",
      "}",
    ].join("\n"),
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /^Repository map:/);
  assert.match(map, /Widget\.java:3: public class Widget/);
  assert.doesNotMatch(map, /System\.out/);
});

// Reason: spec (line 11) — disabling the map reclaims its budget without altering other input.
test("enabled:false removes only the map and leaves the rest of model input unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-disabled-"));
  writeFileSync(
    join(dir, "math.ts"),
    "export function add(a: number): number { return a; }\n",
  );
  const withMap = await manager(dir).build(dir, []);
  assert.match(mapText(withMap), /^Repository map:/);

  const disabled = await manager(dir, settings({ enabled: false })).build(
    dir,
    [],
  );
  assert.equal(mapText(disabled), "");
  const withoutMapMessages = withMap.filter(
    (m) => !(typeof m.content === "string" && m.content.startsWith(HEADER)),
  );
  assert.deepEqual(disabled, withoutMapMessages);
});

// Reason: spec (line 90) — zero budget disables the feature.
test("a zero token budget produces no map header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-zero-budget-"));
  writeFileSync(join(dir, "api.ts"), "export function alpha() {}\n");
  const messages = await manager(dir, settings({ maxTokens: 0 })).build(
    dir,
    [],
  );
  assert.equal(mapText(messages), "");
});

// Reason: spec (lines 9, 33, 83) — binary-search budgeting keeps output under budget and flags omitted definitions.
test("the map stays within its token budget and notes omitted definitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-budget-"));
  for (let i = 0; i < 14; i++) {
    const longParams = Array.from(
      { length: 12 },
      (_, j) => `param${j}: SomeLongTypeName${j}`,
    ).join(", ");
    writeFileSync(
      join(dir, `mod${i}.ts`),
      `export function fn${i}(${longParams}): SomeReturnType { return value; }\n`,
    );
  }
  const maxTokens = 160;
  const messages = await manager(dir, settings({ maxTokens })).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /^Repository map:/);
  assert.match(map, /mod\d+\.ts:1: export function fn/);
  assert.match(map, /omit/i);
  assert.ok(
    estimateMessageTokens({ role: "system", content: map }) <= maxTokens,
  );
});

// Reason: spec (lines 40, 82) — graceful degradation to a ranked file list plus omission note.
test("a workspace too large for any definition degrades to a ranked file list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-fallback-"));
  const long = "a".repeat(180);
  for (let i = 0; i < 3; i++) {
    writeFileSync(
      join(dir, `f${i}.ts`),
      `export function long${i}(${long}): SomeLongReturnType { return value; }\n`,
    );
  }
  const maxTokens = 40;
  const messages = await manager(dir, settings({ maxTokens })).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /^Repository map:/);
  assert.match(map, /f0\.ts/);
  assert.match(map, /f1\.ts/);
  assert.match(map, /f2\.ts/);
  assert.doesNotMatch(map, /export function/);
  assert.match(map, /omit/i);
  assert.ok(
    estimateMessageTokens({ role: "system", content: map }) <= maxTokens,
  );
});

// Reason: spec (lines 12, 88, 90) — hard cap on the number of files considered.
test("maxFiles caps the number of files considered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-max-files-"));
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
  }
  const messages = await manager(dir, settings({ maxFiles: 2 })).build(dir, []);
  const map = mapText(messages);
  const paths = new Set([...map.matchAll(/(f\d)\.ts:\d+:/g)].map((m) => m[1]));
  assert.equal(paths.size, 2);
});

// Reason: spec (lines 31, 51, 79, 113) — cross-file usage signal drives ordering.
test("a name used across many files ranks ahead of a name confined to one file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-ranking-"));
  writeFileSync(
    join(dir, "a.ts"),
    ['import { shared } from "./z";', "export function lonely() {}"].join("\n"),
  );
  writeFileSync(join(dir, "b.ts"), 'import { shared } from "./z";\n');
  writeFileSync(join(dir, "c.ts"), "shared;\n");
  writeFileSync(join(dir, "z.ts"), "export function shared() {}\n");

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /z\.ts:1: export function shared/);
  assert.match(map, /a\.ts:2: export function lonely/);
  assert.ok(
    map.indexOf("z.ts:1:") < map.indexOf("a.ts:2:"),
    `expected shared to outrank lonely:\n${map}`,
  );
});

// Reason: spec (lines 32, 80, 87) — deterministic tie-break by path then line; lexicographic traversal before caps.
test("ranking ties break by path then line, independent of creation order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-ties-"));
  // Create in reverse path order to prove output does not follow the filesystem.
  writeFileSync(join(dir, "b.ts"), "export function beta() {}\n");
  writeFileSync(
    join(dir, "a.ts"),
    ["export function alpha() {}", "", "export function alpha2() {}"].join(
      "\n",
    ),
  );

  const map = mapText(await manager(dir).build(dir, []));

  const alpha = map.indexOf("a.ts:1:");
  const alpha2 = map.indexOf("a.ts:3:");
  const beta = map.indexOf("b.ts:1:");
  assert.ok(alpha >= 0 && alpha2 >= 0 && beta >= 0, map);
  assert.ok(alpha < alpha2, map);
  assert.ok(alpha2 < beta, map);
});

// Reason: spec (lines 29, 80-81) — conventional entry points receive a ranking boost.
test("high-signal project files are boosted in the ranking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-high-signal-"));
  writeFileSync(join(dir, "alpha.ts"), "export function ordinary() {}\n");
  writeFileSync(
    join(dir, "vite.config.ts"),
    "export function configHelper() {}\n",
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /vite\.config\.ts:1: export function configHelper/);
  assert.match(map, /alpha\.ts:1: export function ordinary/);
  assert.ok(map.indexOf("vite.config.ts:1:") < map.indexOf("alpha.ts:1:"), map);
});

// Reason: spec (lines 21-24, 88) — workspace hygiene skips vendored, built, hidden, and scratch paths.
test("dependency, build-output, VCS, hidden and scratch directories are skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-hygiene-"));
  const skipped: Array<[string, string]> = [
    [".hidden/hidden.ts", "hiddenDef"],
    ["node_modules/dep.ts", "depDef"],
    ["dist/built.ts", "builtDef"],
    ["build/compiled.ts", "compiledDef"],
    [".git/vcs.ts", "vcsDef"],
    [".scratch/note.ts", "noteDef"],
    ["vendor/v.ts", "vendorDef"],
    ["target/target.ts", "targetDef"],
    ["scratch/s.ts", "scratchDef"],
    ["CVS/c.ts", "cvsDef"],
  ];
  for (const [rel, name] of skipped) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `export function ${name}() {}\n`);
  }
  writeFileSync(join(dir, "keep.ts"), "export function keptDef() {}\n");

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /keptDef/);
  for (const [, name] of skipped) {
    assert.doesNotMatch(map, new RegExp(name), `unexpected ${name} in map`);
  }
});

// Reason: spec (lines 30, 81) — instruction files are injected separately and excluded from the map.
test("project instruction files are not duplicated in the map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-instructions-"));
  writeFileSync(
    join(dir, "AGENTS.md"),
    "export function instructionOnly() {}\n",
  );
  writeFileSync(join(dir, "CLAUDE.md"), "export function claudeOnly() {}\n");
  writeFileSync(join(dir, "src.ts"), "export function realDef() {}\n");

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /realDef/);
  assert.doesNotMatch(map, /instructionOnly/);
  assert.doesNotMatch(map, /claudeOnly/);
});

// Reason: spec (lines 26, 28, 41, 88) — per-file failures are skipped without failing the turn.
test("oversized, minified, unreadable and malformed files are isolated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-isolation-"));
  writeFileSync(
    join(dir, "oversized.ts"),
    `export function oversizedDef() {}\n${"x".repeat(70 * 1024)}\n`,
  );
  const minifiedParams = Array.from({ length: 100 }, (_, i) => `p${i}`).join(
    ", ",
  );
  writeFileSync(
    join(dir, "minified.ts"),
    `export function minifiedDef(${minifiedParams}) {}\n`,
  );
  const unreadable = join(dir, "unreadable.ts");
  writeFileSync(unreadable, "export function unreadableDef() {}\n");
  chmodSync(unreadable, 0);
  writeFileSync(
    join(dir, "malformed.ts"),
    "export function malformedDef() {}\n\0\0",
  );
  writeFileSync(join(dir, "good.ts"), "export function goodDef() {}\n");

  const messages = await manager(dir).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /goodDef/);
  for (const name of [
    "oversizedDef",
    "minifiedDef",
    "unreadableDef",
    "malformedDef",
  ]) {
    assert.doesNotMatch(map, new RegExp(name), `unexpected ${name} in map`);
  }
  chmodSync(unreadable, 0o644);
});

// Reason: spec (lines 34, 82) — signature line length is capped independently of the minified-file skip.
test("legitimately long signature lines are capped without dropping the definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-signature-cap-"));
  const params = Array.from(
    { length: 12 },
    (_, i) => `param${i}: LongTypeName${i}`,
  ).join(", ");
  writeFileSync(
    join(dir, "long.ts"),
    `export function longSignature(${params}): ReturnType { return value; }\n`,
  );

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /long\.ts:1: export function longSignature/);
  assert.doesNotMatch(map, /param11/);
  assert.match(map, /…/);
});

// Reason: spec (lines 32, 87, 116) — path-sorted deterministic output even when the file cap is active.
test("identical workspaces over the file cap produce identical, path-sorted output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-cap-order-"));
  for (let i = 9; i >= 0; i--) {
    writeFileSync(join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
  }
  const opts = settings({ maxFiles: 3 });
  const cm = manager(dir, opts);
  const first = mapText(await cm.build(dir, []));
  cm.invalidateCaches();
  const second = mapText(await cm.build(dir, []));

  assert.equal(second, first);
  assert.deepEqual(
    [...first.matchAll(/(f\d)\.ts:\d+:/g)].map((m) => m[1]),
    ["f0", "f1", "f2"],
  );
});

// Reason: spec (lines 32, 87) — case-sensitive lexicographic order is established before caps.
test("traversal order is case-sensitive lexicographic before the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-case-order-"));
  writeFileSync(join(dir, "alpha.ts"), "export function lower() {}\n");
  writeFileSync(join(dir, "Beta.ts"), "export function upperB() {}\n");
  writeFileSync(join(dir, "Alpha.ts"), "export function upperA() {}\n");

  const map = mapText(
    await manager(dir, settings({ maxFiles: 2 })).build(dir, []),
  );

  assert.match(map, /Alpha\.ts:1: export function upperA/);
  assert.match(map, /Beta\.ts:1: export function upperB/);
  assert.doesNotMatch(map, /lower/);
});

// Reason: spec (lines 29, 82) — the degraded file list uses the same high-signal-aware ranking.
test("the file-list fallback ranks high-signal files first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-fallback-rank-"));
  const long = "a".repeat(180);
  writeFileSync(
    join(dir, "alpha.ts"),
    `export function ordinary(${long}): Ret { return v; }\n`,
  );
  writeFileSync(
    join(dir, "vite.config.ts"),
    `export function configHelper(${long}): Ret { return v; }\n`,
  );

  const map = mapText(
    await manager(dir, settings({ maxTokens: 50 })).build(dir, []),
  );

  assert.match(map, /^Repository map:/);
  assert.match(map, /vite\.config\.ts/);
  assert.match(map, /alpha\.ts/);
  assert.doesNotMatch(map, /export function/);
  assert.ok(map.indexOf("vite.config.ts") < map.indexOf("alpha.ts"), map);
});

// Reason: spec (lines 47, 88) — a per-file definition cap stops one large file crowding out others.
test("a per-file definition cap stops one large file from crowding out others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-def-cap-"));
  const many = Array.from(
    { length: 300 },
    (_, i) => `export function bigFn${i}() {}`,
  ).join("\n");
  writeFileSync(join(dir, "big.ts"), many + "\n");
  writeFileSync(join(dir, "small.ts"), "export function smallMarker() {}\n");

  const map = mapText(await manager(dir).build(dir, []));

  assert.match(map, /big\.ts:1: export function bigFn0/);
  assert.match(map, /small\.ts:1: export function smallMarker/);
});

// Reason: spec (lines 82, 113) — definitions group by file while usage still orders files.
test("definitions are grouped by file without losing usage-based file ordering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-group-"));
  writeFileSync(
    join(dir, "b.ts"),
    "export function hub() {}\nexport function leaf() {}\n",
  );
  writeFileSync(join(dir, "a.ts"), "export function mid() {}\n");
  writeFileSync(join(dir, "r1.ts"), "hub; mid;\n");
  writeFileSync(join(dir, "r2.ts"), "hub;\n");
  writeFileSync(join(dir, "r3.ts"), "hub;\n");

  const map = mapText(await manager(dir).build(dir, []));

  const hub = map.indexOf("b.ts:1:");
  const leaf = map.indexOf("b.ts:2:");
  const mid = map.indexOf("a.ts:1:");
  assert.ok(hub >= 0 && leaf >= 0 && mid >= 0, map);
  assert.ok(leaf < mid, `expected b.ts definitions grouped together:\n${map}`);
  assert.ok(hub < mid, `expected usage-central hub to outrank mid:\n${map}`);
});

// Reason: spec (line 79, testing line 113) — files with no definitions still contribute usages.
test("reference-only files contribute to the cross-file usage signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-usage-refs-"));
  writeFileSync(join(dir, "a.ts"), "export function isolated() {}\n");
  writeFileSync(join(dir, "z.ts"), "export function central() {}\n");
  for (let i = 1; i <= 4; i++) {
    writeFileSync(join(dir, `r${i}.ts`), "central;\n");
  }

  const map = mapText(await manager(dir).build(dir, []));

  const isolated = map.indexOf("a.ts:1:");
  const central = map.indexOf("z.ts:1:");
  assert.ok(isolated >= 0 && central >= 0, map);
  assert.ok(
    central < isolated,
    `expected central, used only in reference-only files, first:\n${map}`,
  );
});

// Reason: spec (lines 29, 51, 80-81) — usage must be able to outweigh the high-signal boost.
test("cross-file usage outranks a high-signal file with isolated definitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-rank-balance-"));
  writeFileSync(
    join(dir, "vite.config.ts"),
    "export function configHelper() {}\n",
  );
  writeFileSync(join(dir, "core.ts"), "export function central() {}\n");
  for (let i = 1; i <= 4; i++) {
    writeFileSync(join(dir, `r${i}.ts`), "central;\n");
  }

  const map = mapText(await manager(dir).build(dir, []));

  const central = map.indexOf("core.ts:1:");
  const config = map.indexOf("vite.config.ts:1:");
  assert.ok(central >= 0 && config >= 0, map);
  assert.ok(
    central < config,
    `expected usage-central core.ts ahead of high-signal config:\n${map}`,
  );
});
