// Contract tests for ticket 02 (transactional activation).
//
// Seams under test:
//   - ExtensionLoader.loadAll()/list()/report()/doctor()/notifySessionEnd():
//     a failed activation must leave zero registrations behind.
//   - collectExtensionTools(): the model-visible tool set must not include
//     tools registered by a factory that threw.
//   - processedCount(): the /extensions summary must count only loaded records.
//
// Each test names the failure it pins: a factory that registers state and then
// throws must contribute nothing to the running host.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { collectExtensionTools } from "../../dist/extensions/tool-adapter.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-txn-"));
}

function makeLoader(dir: string): ExtensionLoader {
  return new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
}

test("factory that registers a tool then throws exposes no model-visible tool", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "leaky.js"),
      "export default (api) => { api.registerTool({ name: 'leaky', label: 'l', description: 'd', execute: async () => 'x' }); throw new Error('boom'); };\n",
    );
    writeFileSync(
      join(dir, "good.js"),
      "export default (api) => { api.registerTool({ name: 'good', label: 'g', description: 'd', execute: async () => 'ok' }); };\n",
    );
    const loader = makeLoader(dir);
    const loaded = await loader.loadAll();

    const failed = loaded.find((entry) => entry.id === "leaky");
    assert.equal(failed?.status, "error");
    assert.equal(failed?.registries.tools.size, 0);
    const tools = collectExtensionTools(loader).map(
      (tool) => tool.definition.name,
    );
    assert.deepEqual(tools, ["good"]);
    assert.equal(
      loader.list().find((e) => e.id === "leaky")?.registries.tools.size,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory that registers event handlers then throws never fires them", async () => {
  const dir = tempDir();
  const errMarker = join(dir, "err-fired");
  const endMarker = join(dir, "end-fired");
  try {
    writeFileSync(
      join(dir, "handlers.js"),
      [
        'import { writeFileSync } from "node:fs";',
        "export default (api) => {",
        `  api.on("extension_error", () => writeFileSync(${JSON.stringify(errMarker)}, "fired"));`,
        `  api.on("session_end", () => writeFileSync(${JSON.stringify(endMarker)}, "fired"));`,
        '  throw new Error("boom");',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    const loaded = await loader.loadAll();

    assert.equal(loaded[0].status, "error");
    assert.equal(loaded[0].registries.handlers.size, 0);
    loader.notifySessionEnd();
    assert.equal(existsSync(errMarker), false, "extension_error handler fired");
    assert.equal(existsSync(endMarker), false, "session_end handler fired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports the failure with zero registrations and keeps the error stack", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "noisy.js"),
      [
        "export default (api) => {",
        "  api.registerTool({ name: 'leaky', label: 'l', description: 'd', execute: async () => 'x' });",
        "  api.registerCommand({ name: 'leaky', run: async () => {} });",
        '  api.on("message", () => {});',
        "  api.registerProvider({ name: 'leaky', config: {} });",
        "  api.registerFlag('leaky', { default: true });",
        "  api.setStatus('part', 'value');",
        '  throw new Error("boom");',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    const report = loader.report()[0];
    assert.equal(report.status, "error");
    assert.equal(report.toolCount, 0);
    assert.equal(report.commandCount, 0);
    assert.match(report.error ?? "", /boom/);

    const record = loader.list()[0];
    assert.match(record.errorStack ?? "", /boom/);
    assert.equal(record.registries.handlers.size, 0);
    assert.equal(record.registries.providers.size, 0);
    assert.equal(record.registries.flags.size, 0);
    assert.equal(record.registries.status.size, 0);

    const doctor = loader.doctor();
    assert.match(doctor, /error/);
    assert.match(doctor, /0 tools, 0 commands, 0 event types/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a module is imported once even though named and default exports are resolved", async () => {
  const dir = tempDir();
  const countFile = join(dir, "import-count");
  try {
    writeFileSync(
      join(dir, "once.js"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        `const countPath = ${JSON.stringify(countFile)};`,
        "let n = 0;",
        "try { n = Number(readFileSync(countPath, 'utf8')); } catch {}",
        "writeFileSync(countPath, String(n + 1));",
        "export default (api) => {};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "loaded");
    assert.equal(readFileSync(countFile, "utf8"), "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processedCount counts only loaded records", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "good.js"), "export default () => {};\n");
    writeFileSync(
      join(dir, "bad.js"),
      'export default () => { throw new Error("boom"); };\n',
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    assert.equal(loader.processedCount(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
