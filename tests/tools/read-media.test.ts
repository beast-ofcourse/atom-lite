import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRead as read } from "./read-test-helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

// Contract: media detection uses bytes, not the filename, so renamed images still attach.
test("read detects images by magic bytes regardless of extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-media-"));
  writeFileSync(join(dir, "no-extension"), PNG);
  writeFileSync(join(dir, "wrong.txt"), PNG);

  for (const name of ["no-extension", "wrong.txt"]) {
    const result = await read(dir, { path: name });
    assert.equal(result.isError, undefined);
    assert.equal(result.images?.length, 1);
    assert.equal(result.images![0].mime, "image/png");
    assert.match(result.content, /Image file:/);
  }
});

// Regression: a partial signature or an image-like extension must not hide text content.
test("read treats text with an image-looking extension as text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-media-text-"));
  writeFileSync(join(dir, "partial.png"), "GIF8 is text\n");
  writeFileSync(join(dir, "plain.jpg"), "hello\n");

  const partial = await read(dir, { path: "partial.png" });
  assert.equal(partial.images, undefined);
  assert.match(partial.content, /1: GIF8 is text/);

  const plain = await read(dir, { path: "plain.jpg" });
  assert.equal(plain.images, undefined);
  assert.match(plain.content, /1: hello/);
});

// Contract: PDFs attach inline with their mime type and a short confirmation.
test("read attaches a PDF with its mime type and name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-pdf-"));
  writeFileSync(join(dir, "doc.pdf"), PDF);
  const result = await read(dir, { path: "doc.pdf" });
  assert.equal(result.isError, undefined);
  assert.equal(result.images?.length, 1);
  assert.equal(result.images![0].mime, "application/pdf");
  assert.equal(result.images![0].data, PDF.toString("base64"));
  assert.match(result.content, /PDF file: doc\.pdf/);
});

// Contract: media ingestion is bounded at 20 MiB and the error names the limit and file.
test("read rejects media larger than 20 MiB with a named limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-media-limit-"));
  const huge = Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]);
  writeFileSync(join(dir, "huge.png"), huge);
  const result = await read(dir, { path: "huge.png" });
  assert.equal(result.isError, true);
  assert.match(result.content, /MEDIA_TOO_LARGE/);
  assert.match(result.content, /20 MiB/);
  assert.match(result.content, /huge\.png/);
});

// Contract: media needs a vision-capable model, with an explicit error otherwise.
test("read rejects images and PDFs when the model has no vision support", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-media-vision-"));
  writeFileSync(join(dir, "pic.png"), PNG);
  writeFileSync(join(dir, "doc.pdf"), PDF);
  for (const name of ["pic.png", "doc.pdf"]) {
    const result = await read(dir, { path: name }, { supportsVision: false });
    assert.equal(result.isError, true);
    assert.match(result.content, /vision not supported/);
  }
});

// Contract: the capability error wins over the ingest limit for a non-vision model.
test("read reports missing vision before the media size limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-media-vision-first-"));
  const huge = Buffer.concat([PDF, Buffer.alloc(21 * 1024 * 1024)]);
  writeFileSync(join(dir, "huge.pdf"), huge);
  const result = await read(dir, { path: "huge.pdf" }, { supportsVision: false });
  assert.equal(result.isError, true);
  assert.match(result.content, /vision not supported/);
  assert.doesNotMatch(result.content, /MEDIA_TOO_LARGE/);
});

// Contract: the text file size cap stays at 10 MiB after the media cap was added.
test("read keeps the 10 MiB limit for non-media files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-text-limit-"));
  writeFileSync(join(dir, "big.txt"), Buffer.alloc(11 * 1024 * 1024, 0x61));
  const result = await read(dir, { path: "big.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content, /FILE_TOO_LARGE/);
});
