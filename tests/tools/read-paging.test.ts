import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRead as read } from "./read-test-helpers.ts";
import { readTool } from "../../dist/tools/index.js";

// Contract: a range read stops at the page boundary and tells the model where to resume.
test("read pages a long file with a continuation cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-page-"));
  writeFileSync(join(dir, "five.txt"), "a\nb\nc\nd\ne\n");

  const first = await read(dir, { path: "five.txt", limit: 2 });
  assert.match(first.content, /^File: five\.txt/);
  assert.match(first.content, /1: a\n2: b/);
  assert.doesNotMatch(first.content, /3: c/);
  assert.match(first.content, /Continue reading with offset: 3/);

  const second = await read(dir, { path: "five.txt", offset: 3, limit: 2 });
  assert.match(second.content, /3: c\n4: d/);
  assert.match(second.content, /Continue reading with offset: 5/);

  const last = await read(dir, { path: "five.txt", offset: 5, limit: 2 });
  assert.match(last.content, /5: e/);
  assert.doesNotMatch(last.content, /Continue reading with offset/);
});

// Contract: the default page is 2000 lines and resumes at absolute line 2001.
test("read defaults to a 2000-line page and continues at the next line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-lines-"));
  const lines = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`);
  writeFileSync(join(dir, "long.txt"), lines.join("\n") + "\n");

  const first = await read(dir, { path: "long.txt" });
  assert.match(first.content, /1: L1/);
  assert.match(first.content, /2000: L2000/);
  assert.doesNotMatch(first.content, /2001: L2001/);
  assert.match(first.content, /Continue reading with offset: 2001/);

  const rest = await read(dir, { path: "long.txt", offset: 2001 });
  assert.match(rest.content, /2001: L2001/);
  assert.doesNotMatch(rest.content, /Continue reading with offset/);
});

// Contract: a 2500-character line is clamped and UTF-8 survives a 256 KiB chunk boundary.
test("read clamps very long lines and keeps multi-byte text intact across chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-clamp-"));
  writeFileSync(join(dir, "wide.txt"), "x".repeat(2500) + "\ntail\n");
  const clamped = await read(dir, { path: "wide.txt" });
  assert.match(clamped.content, /\.\.\. \(line truncated to 2000 chars\)/);
  assert.match(clamped.content, /2: tail/);
  assert.ok(!clamped.content.includes("x".repeat(2001)));

  const boundary = "a\n".repeat(131072) + "é\n";
  writeFileSync(join(dir, "boundary.txt"), boundary);
  const split = await read(dir, { path: "boundary.txt", offset: 131073, limit: 1 });
  assert.match(split.content, /131073: é/);
});

// Contract: the runtime output cap clips before the internal budget and the cursor names the first unseen line.
test("read applies the runtime output cap before the internal budget and keeps the cursor accurate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-cap-"));
  writeFileSync(join(dir, "cap.txt"), "abcdefghij\n".repeat(10));

  const first = await read(dir, { path: "cap.txt" }, { maxToolOutputBytes: 200 });
  const match = first.content.match(/Continue reading with offset: (\d+)/);
  assert.ok(match, first.content);
  const cursor = Number(match![1]);
  assert.ok(cursor > 1 && cursor <= 10, `unexpected cursor ${cursor}`);
  assert.ok(!first.content.includes(`${cursor}: `), first.content);

  const second = await read(dir, { path: "cap.txt", offset: cursor }, { maxToolOutputBytes: 200 });
  assert.match(second.content, new RegExp(`${cursor}: abcdefghij`));
});

// Regression: a BOM only disappears at the true start, and a NUL outside the page must not reject the read.
test("read handles BOM only at the true start and ignores NUL outside the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-encoding-"));
  writeFileSync(join(dir, "bom.txt"), "\ufefffirst\nsecond\n");
  const head = await read(dir, { path: "bom.txt" });
  assert.match(head.content, /1: first/);
  assert.ok(!head.content.includes("\ufeff"));
  const tail = await read(dir, { path: "bom.txt", offset: 2 });
  assert.match(tail.content, /2: second/);

  writeFileSync(join(dir, "inner.txt"), "first\n\ufeffsecond\n");
  const inner = await read(dir, { path: "inner.txt", offset: 2 });
  assert.match(inner.content, /2: \ufeffsecond/);

  writeFileSync(join(dir, "nul.txt"), "clean\nNUL\0here\n");
  const clean = await read(dir, { path: "nul.txt", limit: 1 });
  assert.match(clean.content, /1: clean/);
  assert.doesNotMatch(clean.content, /Binary file detected/);
  const dirty = await read(dir, { path: "nul.txt", offset: 2, limit: 1 });
  assert.match(dirty.content, /Binary file detected/);
});

// Regression: NUL detection must also apply to lines selected by a past-end tail read.
test("read detects NUL bytes inside a past-end tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-tail-nul-"));
  writeFileSync(join(dir, "nul.txt"), "clean\nNUL\0here\n");
  const tail = await read(dir, { path: "nul.txt", offset: 99 });
  assert.match(tail.content, /Binary file detected/);
});

// Contract: a past-end offset returns a bounded tail; an empty file reports zero lines.
test("read returns a bounded tail for a past-end offset and reports empty files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-tail-"));
  const lines = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
  writeFileSync(join(dir, "many.txt"), lines.join("\n") + "\n");
  const tail = await read(dir, { path: "many.txt", offset: 500, limit: 5 });
  assert.match(tail.content, /offset 500 is past the end; the file has 200 lines/);
  assert.match(tail.content, /196: L196/);
  assert.match(tail.content, /200: L200/);
  assert.doesNotMatch(tail.content, /195: L195/);
  assert.doesNotMatch(tail.content, /Continue reading with offset/);

  writeFileSync(join(dir, "empty.txt"), "");
  const empty = await read(dir, { path: "empty.txt" });
  assert.match(empty.content, /\(empty\)/);
  assert.match(empty.content, /0 bytes/);
  assert.match(empty.content, /0 lines/);
});

// Regression: when no line fits, a cursor must not be paired with a claim that the file is empty.
test("read reports a tiny output cap without claiming an empty file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-tiny-cap-"));
  writeFileSync(join(dir, "tiny.txt"), "abcdefghij\n".repeat(10));
  const result = await read(dir, { path: "tiny.txt" }, { maxToolOutputBytes: 100 });
  assert.match(result.content, /no lines fit the output cap/);
  assert.match(result.content, /Continue reading with offset: 1/);
  assert.doesNotMatch(result.content, /\(empty\)/);
});

// Regression: a clipped past-end tail must point at a real line, not an offset still past EOF.
test("read keeps a real line number in the cursor when a past-end tail is clipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-tail-cursor-"));
  const lines = Array.from({ length: 150 }, (_, i) => `L${i + 1}` + "x".repeat(1000));
  writeFileSync(join(dir, "tailcap.txt"), lines.join("\n") + "\n");
  const first = await read(dir, { path: "tailcap.txt", offset: 999, limit: 100 });
  const match = first.content.match(/Continue reading with offset: (\d+)/);
  assert.ok(match, first.content.slice(0, 200));
  const cursor = Number(match![1]);
  assert.ok(cursor >= 1 && cursor <= 150, `unexpected cursor ${cursor}`);
  const second = await read(dir, { path: "tailcap.txt", offset: cursor, limit: 1 });
  assert.match(second.content, new RegExp(`${cursor}: L${cursor}`));
});

// Contract: the text header names the line range and the tool tells the model the prefix is reference only.
test("read names the returned line range and marks line prefixes as reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-header-"));
  writeFileSync(join(dir, "range.txt"), "a\nb\nc\n");
  const result = await read(dir, { path: "range.txt", limit: 2 });
  assert.match(result.content, /\(lines 1-2\)/);
  assert.match(readTool.definition.description, /prefix is for reference/);
});

// Contract: the hash covers the whole file even when the model sees a single page.
test("read hashes the whole file even when only one page is returned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-hash-"));
  const full = "alpha\nbeta\ngamma\n";
  writeFileSync(join(dir, "hash.txt"), full);
  const expected = createHash("sha256").update(full).digest("hex");
  const page = await read(dir, { path: "hash.txt", offset: 2, limit: 1 });
  assert.ok(page.content.includes(`sha256:${expected}`), page.content);
});
