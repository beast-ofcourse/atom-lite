import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initLsp,
  lspEnabled,
  touchFile,
  getDiagnostics,
  documentSymbols,
  workspaceSymbols,
  shutdownLsp,
} from "../../dist/lsp/index.js";
import { resolveRoot, matchesExtension } from "../../dist/lsp/server.js";

const FAKE = resolve(process.cwd(), "tests/fixtures/lsp-fake-server.mjs");

function cfg(ws: string) {
  return {
    lsp: {
      enabled: true,
      servers: {
        fake: {
          command: "node",
          args: [FAKE],
          extensions: [".ts"],
          rootMarkers: [],
          disabled: false,
        },
      },
    },
  } as any;
}

test("lazy spawns and caches diagnostics", async () => {
  const ws = mkdtempSync(join(tmpdir(), "lsp-"));
  writeFileSync(join(ws, "a.ts"), "const x = 1;\n");
  const file = join(ws, "a.ts");
  initLsp(cfg(ws), ws);
  assert.equal(lspEnabled(), true);
  await touchFile(file);
  await new Promise((r) => setTimeout(r, 100));
  const d = await getDiagnostics(file);
  assert.equal(d.size, 1);
  const msgs = [...d.values()][0].map((x: any) => x.message);
  assert.deepEqual(msgs, ["fake diag"]);
  await shutdownLsp();
});

test("diagnostics cached without republish", async () => {
  const ws = mkdtempSync(join(tmpdir(), "lsp-"));
  writeFileSync(join(ws, "a.ts"), "const x = 1;\n");
  const file = join(ws, "a.ts");
  initLsp(cfg(ws), ws);
  await touchFile(file);
  await new Promise((r) => setTimeout(r, 100));
  const d1 = await getDiagnostics(file);
  const d2 = await getDiagnostics(file);
  assert.equal(d1.size, d2.size);
  await shutdownLsp();
});

test("documentSymbols and workspaceSymbols", async () => {
  const ws = mkdtempSync(join(tmpdir(), "lsp-"));
  writeFileSync(join(ws, "a.ts"), "const x = 1;\n");
  const file = join(ws, "a.ts");
  initLsp(cfg(ws), ws);
  await touchFile(file);
  const syms = await documentSymbols(file);
  assert.deepEqual(syms, [{ name: "Foo", kind: 12 }]);
  const wsyms = await workspaceSymbols("q");
  assert.deepEqual(wsyms, [{ name: "Bar", kind: 12 }]);
  await shutdownLsp();
});

test("clean shutdown", async () => {
  const ws = mkdtempSync(join(tmpdir(), "lsp-"));
  writeFileSync(join(ws, "a.ts"), "const x = 1;\n");
  initLsp(cfg(ws), ws);
  await touchFile(join(ws, "a.ts"));
  await shutdownLsp();
  // second shutdown safe
  await shutdownLsp();
});

test("resolveRoot and matchesExtension", () => {
  const ws = mkdtempSync(join(tmpdir(), "lsp-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "package.json"), "{}");
  const server = {
    id: "t",
    extensions: [".ts"],
    rootMarkers: ["package.json"],
    command: "node",
    args: [],
    initialization: {},
  } as any;
  const file = join(ws, "src", "a.ts");
  assert.equal(resolveRoot(server, file, ws), ws);
  assert.equal(resolveRoot(server, "/etc/hostname", ws), null);
  assert.equal(matchesExtension(server, file), true);
});
