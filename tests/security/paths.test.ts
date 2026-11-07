import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinWorkspace } from "../../dist/security/paths.js";

test("isWithinWorkspace: file inside workspace is allowed", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  try {
    assert.equal(isWithinWorkspace(ws, "foo.txt"), true);
    assert.equal(isWithinWorkspace(ws, "a/b/c.txt"), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("isWithinWorkspace: parent escape is rejected", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  try {
    assert.equal(isWithinWorkspace(ws, "../outside.txt"), false);
    assert.equal(isWithinWorkspace(ws, "a/../../outside.txt"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("isWithinWorkspace: absolute path inside workspace is allowed", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  try {
    assert.equal(isWithinWorkspace(ws, join(ws, "foo.txt")), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("isWithinWorkspace: absolute path outside workspace is rejected", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  const other = mkdtempSync(join(tmpdir(), "atom-other-"));
  try {
    assert.equal(isWithinWorkspace(ws, join(other, "foo.txt")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("isWithinWorkspace: symlinked parent directory is rejected", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  const outside = mkdtempSync(join(tmpdir(), "atom-outside-"));
  try {
    symlinkSync(outside, join(ws, "link"));
    assert.equal(isWithinWorkspace(ws, "link/secret.txt"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("isWithinWorkspace: workspace root itself is allowed", () => {
  const ws = mkdtempSync(join(tmpdir(), "atom-paths-"));
  try {
    assert.equal(isWithinWorkspace(ws, "."), true);
    assert.equal(isWithinWorkspace(ws, ""), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
