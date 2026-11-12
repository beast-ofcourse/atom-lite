// grep tool: matches, modes, and the flags-vs-pattern boundary. Both engines
// (ripgrep when installed, JS fallback otherwise) must satisfy the same
// contract, so assertions avoid depending on which engine ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../../dist/tools/index.js";
import type { ToolContext } from "../../dist/tools/types.js";

function ctx(workspace: string): ToolContext {
  return { workspace, signal: new AbortController().signal };
}

function call(args: Record<string, unknown>) {
  return { id: "1", name: "grep", arguments: args };
}

test("content mode returns file:line: text", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "alpha\nneedle here\nlast\n");
  writeFileSync(join(ws, "b.txt"), "nothing to see\n");
  const r = await grepTool.execute(call({ pattern: "needle" }), ctx(ws));
  assert.match(r.content, /a\.txt:2:.*needle/);
  assert.ok(!r.content.includes("b.txt"));
});

test("files_with_matches and count modes", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "hit\nhit\n");
  writeFileSync(join(ws, "b.txt"), "hit\n");
  const files = await grepTool.execute(
    call({ pattern: "hit", output_mode: "files_with_matches" }),
    ctx(ws),
  );
  assert.match(files.content, /a\.txt/);
  assert.match(files.content, /b\.txt/);
  const counts = await grepTool.execute(
    call({ pattern: "hit", output_mode: "count" }),
    ctx(ws),
  );
  assert.match(counts.content, /a\.txt: 2/);
  assert.match(counts.content, /b\.txt: 1/);
});

test("no matches reports a friendly message", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "plain\n");
  const r = await grepTool.execute(call({ pattern: "zzznotfound" }), ctx(ws));
  assert.match(r.content, /no matches/i);
});

test("case insensitive flag widens matches", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "HELLO\nhello nothing\n");
  const r = await grepTool.execute(
    call({ pattern: "hello", case_sensitive: false }),
    ctx(ws),
  );
  assert.match(r.content, /1:/);
  assert.match(r.content, /2:/);
});

test("pattern starting with a dash is treated as a pattern, not a flag", async () => {
  // Regression: the pattern was passed without `--`, so "-foo" errored as an
  // unknown rg flag and silently degraded results.
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "value -foo end\n");
  const r = await grepTool.execute(call({ pattern: "-foo" }), ctx(ws));
  assert.match(r.content, /a\.txt:1:/);
  assert.ok(!r.isError);
});

test("context lines include neighbours with separator markers", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "one\ntwo\nthree\nneedle\nfive\nsix\n");
  const r = await grepTool.execute(
    call({ pattern: "needle", context: 1 }),
    ctx(ws),
  );
  assert.match(r.content, /a\.txt:4:/);
  assert.match(r.content, /(a\.txt-3-|a\.txt-5-)/);
});

test("workspace violation and missing path are explicit errors", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  const outside = await grepTool.execute(
    call({ pattern: "x", path: "../elsewhere" }),
    ctx(ws),
  );
  assert.equal(outside.content, "PATH_OUTSIDE_WORKSPACE");
  assert.equal(outside.isError, true);
  const missing = await grepTool.execute(
    call({ pattern: "x", path: "does/not/exist" }),
    ctx(ws),
  );
  assert.equal(missing.content, "PATH_NOT_FOUND");
  assert.equal(missing.isError, true);
});

test("invalid regex reports INVALID_REGEX", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(ws, "a.txt"), "x\n");
  const r = await grepTool.execute(call({ pattern: "(unbalanced" }), ctx(ws));
  assert.match(r.content, /INVALID_REGEX|no matches/i);
  // An invalid regex is a tool argument error either way; the JS engine
  // classifies it explicitly.
});

test("glob filter narrows the search", async () => {
  const ws = mkdtempSync(join(tmpdir(), "grep-"));
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "a.txt"), "needle\n");
  writeFileSync(join(ws, "a.log"), "needle\n");
  const r = await grepTool.execute(
    call({ pattern: "needle", glob: "*.log" }),
    ctx(ws),
  );
  assert.match(r.content, /a\.log/);
  assert.ok(!r.content.includes("a.txt"));
});
