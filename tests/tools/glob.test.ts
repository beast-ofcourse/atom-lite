// glob tool: pattern matching, workspace guards, caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

function ctx(workspace: string): ToolContext {
  return { workspace, signal: new AbortController().signal };
}

function call(args: Record<string, unknown>) {
  return { id: "1", name: "glob", arguments: args };
}

test("matches files by pattern, relative to workspace", async () => {
  const ws = mkdtempSync(join(tmpdir(), "glob-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "");
  writeFileSync(join(ws, "b.md"), "");
  const r = await globTool.execute(call({ pattern: "**/*.ts" }), ctx(ws));
  assert.match(r.content, /src\/a\.ts|src\\a\.ts/);
  assert.ok(!r.content.includes("b.md"));
});

test("no matches reports (no matches)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "glob-"));
  const r = await globTool.execute(call({ pattern: "*.zzz" }), ctx(ws));
  assert.match(r.content, /no matches/i);
});

test("max_results caps the output", async () => {
  const ws = mkdtempSync(join(tmpdir(), "glob-"));
  for (let i = 0; i < 5; i++) writeFileSync(join(ws, `f${i}.txt`), "");
  const r = await globTool.execute(
    call({ pattern: "*.txt", max_results: 2 }),
    ctx(ws),
  );
  assert.equal(r.content.split("\n").filter((l) => l.trim()).length, 2);
});

test("path scope and guards", async () => {
  const ws = mkdtempSync(join(tmpdir(), "glob-"));
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "sub", "s.txt"), "");
  const scoped = await globTool.execute(
    call({ pattern: "*.txt", path: "sub" }),
    ctx(ws),
  );
  assert.match(scoped.content, /s\.txt/);
  const outside = await globTool.execute(
    call({ pattern: "*.txt", path: ".." }),
    ctx(ws),
  );
  assert.equal(outside.content, "PATH_OUTSIDE_WORKSPACE");
  const missing = await globTool.execute(
    call({ pattern: "*.txt", path: "gone" }),
    ctx(ws),
  );
  assert.equal(missing.content, "PATH_NOT_FOUND");
});
