import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { estimateMessageTokens } from "../../dist/context/budget.js";

const HEADER = "Repository map:";

interface RepoMapSettings {
  enabled: boolean;
  maxTokens: number;
  maxFiles: number;
}

function stubProvider(): any {
  return {
    id: "fake",
    generate: async () => ({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
      },
      toolCalls: [],
      finishReason: "stop",
    }),
  };
}

function manager(dir: string, repoMap?: RepoMapSettings): ContextManager {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 100,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: stubProvider(),
    model: "test",
    userInstructionsPath: join(dir, "user-AGENTS.md"),
    ...(repoMap ? { repoMap } : {}),
  });
}

function mapText(messages: any[]): string {
  const found = messages.find(
    (m) => typeof m.content === "string" && m.content.startsWith(HEADER),
  );
  return found ? found.content : "";
}

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

test("a workspace with no extractable definitions produces no map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-empty-"));
  writeFileSync(join(dir, "notes.txt"), "export function add(a) {}\n");
  writeFileSync(join(dir, "empty.js"), "// nothing to declare here\ncall();\n");
  assert.equal(mapText(await manager(dir).build(dir, [])), "");
});

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

test("enabled:false removes only the map and leaves the rest of model input unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-disabled-"));
  writeFileSync(
    join(dir, "math.ts"),
    "export function add(a: number): number { return a; }\n",
  );
  const withMap = await manager(dir).build(dir, []);
  assert.match(mapText(withMap), /^Repository map:/);

  const disabled = await manager(dir, {
    enabled: false,
    maxTokens: 1200,
    maxFiles: 400,
  }).build(dir, []);
  assert.equal(mapText(disabled), "");
  const withoutMapMessages = withMap.filter(
    (m) =>
      !(typeof m.content === "string" && m.content.startsWith(HEADER)),
  );
  assert.deepEqual(disabled, withoutMapMessages);
});

test("a zero token budget produces no map header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-zero-budget-"));
  writeFileSync(join(dir, "api.ts"), "export function alpha() {}\n");
  const messages = await manager(dir, {
    enabled: true,
    maxTokens: 0,
    maxFiles: 400,
  }).build(dir, []);
  assert.equal(mapText(messages), "");
});

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
  const messages = await manager(dir, {
    enabled: true,
    maxTokens,
    maxFiles: 400,
  }).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /^Repository map:/);
  assert.match(map, /mod\d+\.ts:1: export function fn/);
  assert.match(map, /omit/i);
  assert.ok(estimateMessageTokens({ role: "system", content: map }) <= maxTokens);
});

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
  const messages = await manager(dir, {
    enabled: true,
    maxTokens,
    maxFiles: 400,
  }).build(dir, []);
  const map = mapText(messages);

  assert.match(map, /^Repository map:/);
  assert.match(map, /f0\.ts/);
  assert.match(map, /f1\.ts/);
  assert.match(map, /f2\.ts/);
  assert.doesNotMatch(map, /export function/);
  assert.match(map, /omit/i);
  assert.ok(estimateMessageTokens({ role: "system", content: map }) <= maxTokens);
});

test("maxFiles caps the number of files considered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-map-max-files-"));
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
  }
  const messages = await manager(dir, {
    enabled: true,
    maxTokens: 1200,
    maxFiles: 2,
  }).build(dir, []);
  const map = mapText(messages);
  const paths = new Set(
    [...map.matchAll(/(f\d)\.ts:\d+:/g)].map((m) => m[1]),
  );
  assert.equal(paths.size, 2);
});
