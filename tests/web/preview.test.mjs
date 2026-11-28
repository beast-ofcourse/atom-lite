// Reason: the file tab dispatches from one kind and URL contract. A wrong
// kind silently sends a file to the no-preview card; a URL without the run
// token makes its media or download request fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadUrl, fileKind, mediaUrl } from "../../web/files.js";

test("preview kind comes from extension before content type", () => {
  const cases = [
    ["src/app.ts", "text/plain", "text"],
    ["notes.md", "text/plain", "markdown"],
    ["README.markdown", "text/plain", "markdown"],
    ["photo.png", "application/octet-stream", "image"],
    ["diagram.svg", "text/plain", "image"],
    ["clip.mp4", "application/octet-stream", "video"],
    ["clip.webm", "", "video"],
    ["tone.mp3", "", "audio"],
    ["tone.flac", "", "audio"],
    ["paper.pdf", "", "pdf"],
    ["report.docx", "", "document"],
    ["sheet.xlsx", "", "spreadsheet"],
    ["slides.pptx", "", "presentation"],
    ["archive.zip", "application/octet-stream", "none"],
    ["LICENSE", "", "none"],
  ];
  for (const [path, contentType, expected] of cases) {
    assert.equal(fileKind(path, contentType), expected, path);
  }
});

test("markdown content type wins over plain text", () => {
  assert.equal(fileKind("doc", "text/markdown"), "markdown");
  assert.equal(fileKind("doc", "application/pdf"), "pdf");
  assert.equal(fileKind("doc", "image/png"), "image");
});

test("office content types map to their document kinds", () => {
  assert.equal(
    fileKind(
      "file",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "document",
  );
  assert.equal(
    fileKind(
      "file",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "spreadsheet",
  );
  assert.equal(
    fileKind(
      "file",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    "presentation",
  );
  assert.equal(fileKind("file", "image/svg+xml"), "image");
});

test("media and download URLs carry the token and encode the path", () => {
  const token = "a b&c";
  const path = "dir/clip one.mp4";
  assert.equal(
    mediaUrl(path, token),
    `/media?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`,
  );
  assert.equal(
    downloadUrl(path, token),
    `/download?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`,
  );
});
