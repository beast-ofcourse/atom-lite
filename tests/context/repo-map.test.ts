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

const HEADER = "Repository map:";

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

function manager(dir: string): ContextManager {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 100,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: stubProvider(),
    model: "test",
    userInstructionsPath: join(dir, "user-AGENTS.md"),
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
