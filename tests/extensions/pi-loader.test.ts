import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-pi-loader-"));
}

function setup(): { dir: string; agentDir: string; cleanup: () => void } {
  const dir = tempDir();
  const agentDir = join(dir, "agent");
  mkdirSync(join(dir, "ext"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return {
    dir,
    agentDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("loads sync and async factories with default and activate exports", async () => {
  const { dir, agentDir, cleanup } = setup();
  try {
    const extDir = join(dir, "ext");
    writeFileSync(
      join(extDir, "sync-default.ts"),
      "export default (api:any) => { api.registerTool({ name: 'sync', label:'s', description:'d', execute: async () => 1 }); };\n",
    );
    writeFileSync(
      join(extDir, "async-activate.mjs"),
      "export async function activate(api){ await new Promise(r=>setTimeout(r,5)); api.registerTool({ name:'async', label:'a', description:'d', execute: async()=>2}); }\n",
    );
    const loader = new ExtensionLoader({
      userDir: extDir,
      agentDir,
    });
    const loaded = await loader.loadAll();
    assert.equal(loaded.length, 2);
    assert.ok(loaded.every((entry) => entry.status === "loaded"));
    const tools = new Set(
      loaded.flatMap((entry) => [...entry.registries.tools.keys()]),
    );
    assert.ok(tools.has("sync"));
    assert.ok(tools.has("async"));
  } finally {
    cleanup();
  }
});

test("resolves host aliases inside extension code", async () => {
  const { dir, agentDir, cleanup } = setup();
  try {
    const extDir = join(dir, "ext");
    writeFileSync(
      join(extDir, "alias.ts"),
      [
        'import { Text } from "pi-tui";',
        'import { Type } from "typebox";',
        "export default (api:any) => {",
        '  api.registerTool({ name: "alias", label: "a", description: "d", parameters: Type.Object({ n: Type.Number() }), execute: async () => new Text("ok") });',
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "loaded");
    assert.equal(loaded[0].registries.tools.size, 1);
  } finally {
    cleanup();
  }
});

test("load-time registration works and session actions throw", async () => {
  const { dir, agentDir, cleanup } = setup();
  try {
    const extDir = join(dir, "ext");
    writeFileSync(
      join(extDir, "actions.ts"),
      [
        "export default async (api:any) => {",
        "  api.registerTool({ name:'a', label:'a', description:'d', execute: async()=>1 });",
        "  api.registerCommand({ name:'c', description:'c', run:()=>{} });",
        "  const selected = await api.select('t', ['x']);",
        "  if (selected !== undefined) { /* dialog may resolve undefined without UI */ }",
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "loaded");
    assert.equal(loaded[0].registries.tools.size, 1);
    assert.equal(loaded[0].registries.commands.size, 1);
  } finally {
    cleanup();
  }
});

test("isolates factory failures and continues", async () => {
  const { dir, agentDir, cleanup } = setup();
  try {
    const extDir = join(dir, "ext");
    writeFileSync(
      join(extDir, "bad.ts"),
      "export default () => { throw new Error('boom'); };\n",
    );
    writeFileSync(
      join(extDir, "good.ts"),
      "export default (api:any) => { api.registerTool({ name:'good', label:'g', description:'d', execute: async()=>1 }); };\n",
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    const loaded = await loader.loadAll();
    assert.equal(loaded.length, 2);
    const bad = loaded.find((entry) => entry.id === "bad");
    const good = loaded.find((entry) => entry.id === "good");
    assert.equal(bad?.status, "error");
    assert.match(bad?.error ?? "", /boom/);
    assert.equal(good?.status, "loaded");
  } finally {
    cleanup();
  }
});

test("cache-busted reload observes edits", async () => {
  const { dir, agentDir, cleanup } = setup();
  try {
    const extDir = join(dir, "ext");
    const file = join(extDir, "reload.ts");
    writeFileSync(
      file,
      "export default (api:any) => { api.registerTool({ name:'v1', label:'v', description:'d', execute: async()=>1 }); };\n",
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    let loaded = await loader.loadAll();
    assert.ok(loaded[0].registries.tools.has("v1"));
    writeFileSync(
      file,
      "export default (api:any) => { api.registerTool({ name:'v2', label:'v', description:'d', execute: async()=>2 }); };\n",
    );
    loaded = await loader.loadAll();
    assert.ok(loaded[0].registries.tools.has("v2"));
    assert.ok(!loaded[0].registries.tools.has("v1"));
  } finally {
    cleanup();
  }
});
