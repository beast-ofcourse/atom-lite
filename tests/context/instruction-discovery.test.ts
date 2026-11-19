import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { discoverInstructionPaths } from "../../dist/context/instructions.js";

function manager(dir: string): ContextManager {
  return new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 100,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: {
      generate: async () => {
        throw new Error("compaction should not run");
      },
    } as any,
    model: "test",
    userInstructionsPath: join(dir, "missing-user-AGENTS.md"),
  });
}

function text(messages: any[]): string {
  return messages
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}

// Contract: instruction files found beside a read are injected on the next context build.
test("discovered instruction files appear in the next model context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-instructions-"));
  mkdirSync(join(dir, "sub"));
  const nested = join(dir, "sub", "AGENTS.md");
  writeFileSync(nested, "nested guidance");
  const cm = manager(dir);

  assert.doesNotMatch(text(await cm.build(dir, [])), /nested guidance/);
  assert.equal(cm.noteDiscoveredInstructions([nested]), true);
  assert.match(text(await cm.build(dir, [])), /nested guidance/);
  assert.equal(cm.noteDiscoveredInstructions([nested]), false);
});

// Contract: root instruction files keep their existing behavior alongside discovered ones.
test("root instruction files still inject with discovered files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-root-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "AGENTS.md"), "root guidance");
  writeFileSync(join(dir, "sub", "CLAUDE.md"), "child guidance");
  const cm = manager(dir);
  cm.noteDiscoveredInstructions([join(dir, "sub", "CLAUDE.md")]);
  const built = text(await cm.build(dir, []));
  assert.match(built, /root guidance/);
  assert.match(built, /child guidance/);
});

// Regression: a symlinked copy of an instruction file is injected only once.
test("discovered instruction files are deduplicated by resolved path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-dedupe-"));
  mkdirSync(join(dir, "sub"));
  const real = join(dir, "sub", "AGENTS.md");
  const alias = join(dir, "sub", "CLAUDE.md");
  writeFileSync(real, "single copy");
  symlinkSync(real, alias);
  const cm = manager(dir);
  cm.noteDiscoveredInstructions([real, alias]);
  const built = text(await cm.build(dir, []));
  assert.equal(built.match(/single copy/g)?.length, 1);
});

// Contract: the signature includes discovered paths, so changes invalidate the cached instructions.
test("a discovered instruction file invalidates the context cache on change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-cache-"));
  mkdirSync(join(dir, "sub"));
  const nested = join(dir, "sub", "AGENTS.md");
  writeFileSync(nested, "version one");
  const cm = manager(dir);
  cm.noteDiscoveredInstructions([nested]);
  assert.match(text(await cm.build(dir, [])), /version one/);

  writeFileSync(nested, "version two");
  const future = new Date(Date.now() + 5000);
  const { utimesSync } = await import("node:fs");
  utimesSync(nested, future, future);
  const built = text(await cm.build(dir, []));
  assert.match(built, /version two/);
  assert.doesNotMatch(built, /version one/);
});

// Contract: the upward walk stops at the workspace root and excludes it.
test("discovery walks up from a read path to the workspace root exclusive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-walk-"));
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "root");
  writeFileSync(join(dir, "a", "CLAUDE.md"), "a rules");
  writeFileSync(join(dir, "a", "b", "AGENTS.md"), "b rules");
  writeFileSync(join(dir, "a", "b", "file.txt"), "file");
  const found = discoverInstructionPaths(dir, join(dir, "a", "b", "file.txt"));
  assert.deepEqual(found, [
    join(dir, "a", "b", "AGENTS.md"),
    join(dir, "a", "CLAUDE.md"),
  ]);
});

// Contract: discovery outside the workspace is skipped.
test("discovery returns no paths for a target outside the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-nested-external-"));
  const outside = mkdtempSync(join(tmpdir(), "atom-nested-outside-"));
  writeFileSync(join(outside, "AGENTS.md"), "outside");
  assert.deepEqual(
    discoverInstructionPaths(dir, join(outside, "file.txt")),
    [],
  );
});
