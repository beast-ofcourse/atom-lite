import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initLsp,
  lspEnabled,
  touchFile,
  getDiagnostics,
  shutdownLsp,
} from "../../dist/lsp/index.js";

test("LSP is disabled by default", () => {
  const config = { lsp: { enabled: false, servers: {} } } as any;
  initLsp(config, process.cwd());
  assert.equal(lspEnabled(), false);
});

test("touchFile is a no-op when disabled", async () => {
  const config = { lsp: { enabled: false, servers: {} } } as any;
  initLsp(config, process.cwd());
  await touchFile("/tmp/nonexistent.ts");
  const d = await getDiagnostics("/tmp/nonexistent.ts");
  assert.equal(d.size, 0);
  await shutdownLsp();
});
