import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";

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
    userInstructionsPath: join(dir, "user-AGENTS.md"),
  });
}

function text(messages: any[]): string {
  return messages
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}

function touchFuture(path: string): void {
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
}

test("project instructions are cached and invalidated by mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const agents = join(dir, "AGENTS.md");
  const cm = manager(dir);

  writeFileSync(agents, "alpha instructions");
  assert.match(text(await cm.build(dir, [])), /alpha instructions/);

  writeFileSync(agents, "beta instructions");
  touchFuture(agents);
  assert.match(text(await cm.build(dir, [])), /beta instructions/);
});

test("skill index is cached and invalidated by mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-context-"));
  const skillDir = join(dir, ".agents", "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  const cm = manager(dir);

  writeFileSync(
    skillFile,
    "---\nname: demo\ndescription: alpha skill\n---\nbody\n",
  );
  assert.match(text(await cm.build(dir, [])), /demo: alpha skill/);

  writeFileSync(
    skillFile,
    "---\nname: demo\ndescription: beta skill\n---\nbody\n",
  );
  touchFuture(skillFile);
  assert.match(text(await cm.build(dir, [])), /demo: beta skill/);
});
