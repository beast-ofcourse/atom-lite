import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
} from "../../dist/tools/index.js";

function ctx(workspace: string) {
  return { workspace, signal: new AbortController().signal };
}

test("read returns numbered lines and hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  const r = await readTool.execute(
    { id: "1", name: "read", arguments: { path: "a.txt" } },
    ctx(dir),
  );
  assert.match(r.content, /1: line1/);
  assert.match(r.content, /sha256:/);
});

test("write creates file and hash guard rejects stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r1 = await writeTool.execute(
    { id: "1", name: "write", arguments: { path: "b.txt", content: "hi" } },
    ctx(dir),
  );
  assert.match(r1.content, /Wrote 2 bytes/);
  // new file write requires no hash; existing requires hash
  const r2 = await writeTool.execute(
    {
      id: "2",
      name: "write",
      arguments: { path: "b.txt", content: "ho", expected_hash: "bad" },
    },
    ctx(dir),
  );
  assert.equal(r2.isError, true);
});

test("edit exact match and ambiguous handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "c.txt"), "foo\nfoo\n");
  const r = await editTool.execute(
    {
      id: "1",
      name: "edit",
      arguments: { path: "c.txt", old_string: "foo", new_string: "bar" },
    },
    ctx(dir),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /EDIT_AMBIGUOUS_MATCH/);
  writeFileSync(join(dir, "d.txt"), "foo\n");
  const r2 = await editTool.execute(
    {
      id: "2",
      name: "edit",
      arguments: { path: "d.txt", old_string: "foo", new_string: "bar" },
    },
    ctx(dir),
  );
  assert.ok(!r2.isError);
  assert.equal(readFileSync(join(dir, "d.txt"), "utf8"), "bar\n");
});

test("edit not found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "e.txt"), "hello\n");
  const r = await editTool.execute(
    {
      id: "1",
      name: "edit",
      arguments: { path: "e.txt", old_string: "nope", new_string: "x" },
    },
    ctx(dir),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /EDIT_NOT_FOUND/);
});

test("bash runs command and returns output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await bashTool.execute(
    { id: "1", name: "bash", arguments: { command: "echo hello" } },
    ctx(dir),
  );
  assert.match(r.content, /hello/);
  assert.match(r.content, /exit_code: 0/);
});

test("bash warns about shell-based file editing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const r = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: { command: "sed -i 's/one/ONE/' a.txt" },
    },
    ctx(dir),
  );
  assert.match(r.content, /cwd:/);
  assert.match(r.content, /shell-based file editing detected/);
});

test("path escape rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const r = await readTool.execute(
    { id: "1", name: "read", arguments: { path: "../etc/passwd" } },
    ctx(dir),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /PATH_OUTSIDE_WORKSPACE/);
});

test("symlink escape rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  try {
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  } catch {
    return; // symlinks may be unsupported
  }
  const r = await readTool.execute(
    { id: "1", name: "read", arguments: { path: "link.txt" } },
    ctx(dir),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /PATH_OUTSIDE_WORKSPACE/);
});

test("read offset/limit slices lines without changing numbering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "range.txt"), "a\nbb\nccc\n");
  const cases: Array<[number | undefined, number | undefined, string]> = [
    [1, 2, "1: a\n2: bb"],
    [2, 2, "2: bb\n3: ccc"],
    [3, 5, "3: ccc\n4: "],
    [2, 1, "2: bb"],
    [9, 1, "(empty)"],
  ];
  for (const [offset, limit, expected] of cases) {
    const r = await readTool.execute(
      {
        id: "1",
        name: "read",
        arguments: { path: "range.txt", offset, limit },
      },
      ctx(dir),
    );
    assert.ok(r.content.endsWith(expected), `${offset}/${limit}: ${r.content}`);
  }
});

test("read handles CRLF ranges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\nc\r\n");
  const r = await readTool.execute(
    {
      id: "1",
      name: "read",
      arguments: { path: "crlf.txt", offset: 2, limit: 1 },
    },
    ctx(dir),
  );
  assert.match(r.content, /2: b$/);
  assert.ok(!r.content.includes("\r"), "CR should be stripped");
});

test("bash streams stdout and stderr while running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const chunks: Array<{ stream: string; text: string }> = [];
  const c = {
    ...ctx(dir),
    onToolOutput: (
      _call: unknown,
      stream: "stdout" | "stderr",
      text: string,
    ) => {
      chunks.push({ stream, text });
    },
  };
  const r = await bashTool.execute(
    {
      id: "1",
      name: "bash",
      arguments: { command: "echo out; echo err >&2" },
    },
    c,
  );
  assert.match(r.content, /out/);
  assert.ok(
    chunks.some((c) => c.stream === "stdout" && c.text.includes("out")),
  );
  assert.ok(
    chunks.some((c) => c.stream === "stderr" && c.text.includes("err")),
  );
});

test("write and edit attach pre-computed diffs to the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const created = await writeTool.execute(
    {
      id: "1",
      name: "write",
      arguments: { path: "new.txt", content: "one\ntwo\n" },
    },
    ctx(dir),
  );
  assert.deepEqual(created.diff, ["+ one", "+ two"]);

  const edited = await editTool.execute(
    {
      id: "2",
      name: "edit",
      arguments: { path: "new.txt", old_string: "one", new_string: "ONE" },
    },
    ctx(dir),
  );
  assert.ok(edited.diff?.includes("- one"));
  assert.ok(edited.diff?.includes("+ ONE"));
});

test("edit inserts replacement text literally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "a.txt"), "x $& $1 $$ $' `y`");
  const res = await editTool.execute(
    {
      id: "1",
      name: "edit",
      arguments: {
        path: "a.txt",
        old_string: "x $& $1 $$ $' `y`",
        new_string: "replaced $& $1 $$ $' `y`",
      },
    },
    ctx(dir),
  );
  assert.ok(!res.isError);
  assert.equal(
    readFileSync(join(dir, "a.txt"), "utf8"),
    "replaced $& $1 $$ $' `y`",
  );
});

test("read returns image data for vision-capable models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(dir, "pic.png"), png);
  const r = await readTool.execute(
    { id: "i1", name: "read", arguments: { path: "pic.png" } },
    {
      workspace: dir,
      signal: new AbortController().signal,
      supportsVision: true,
    } as any,
  );
  assert.equal(r.isError, undefined);
  assert.ok(r.images && r.images.length === 1);
  assert.equal(r.images![0].mime, "image/png");
});

test("read rejects images for non-vision models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(dir, "pic.png"), png);
  const r = await readTool.execute(
    { id: "i2", name: "read", arguments: { path: "pic.png" } },
    {
      workspace: dir,
      signal: new AbortController().signal,
      supportsVision: false,
    } as any,
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /vision not supported/);
});

test("read rejects oversized images with FILE_TOO_LARGE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const big = Buffer.alloc(11 * 1024 * 1024, 0x89);
  writeFileSync(join(dir, "big.png"), big);
  const r = await readTool.execute(
    { id: "i3", name: "read", arguments: { path: "big.png" } },
    {
      workspace: dir,
      signal: new AbortController().signal,
      supportsVision: true,
    } as any,
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /FILE_TOO_LARGE/);
});
