import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-loader-"));
}

test("loads trusted user extensions", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "ok.js"),
      "export default (atom) => { atom.appendEntry('note', { value: 1 }); };\n",
    );
    const loader = new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
    const loaded = await loader.loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].status, "loaded");
    assert.equal(loaded[0].registries.entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads async factories", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "async.js"),
      "export default async (atom) => { await Promise.resolve(); atom.log('ready'); };\n",
    );
    const loader = new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "loaded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolates factory errors", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "bad.js"), "export default () => { throw new Error('boom'); };\n");
    writeFileSync(join(dir, "good.js"), "export default () => {};\n");
    const loader = new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
    const loaded = await loader.loadAll();
    assert.equal(loaded.find((entry) => entry.id === "bad")?.status, "error");
    assert.match(loaded.find((entry) => entry.id === "bad")?.error ?? "", /boom/);
    assert.equal(loaded.find((entry) => entry.id === "good")?.status, "loaded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips project extensions unless the project is trusted", async () => {
  const projectDir = tempDir();
  try {
    const extensionDir = join(projectDir, ".atom-lite", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "project.js"), "export default () => {};\n");

    const isolate = {
      projectDir,
      agentDir: join(projectDir, "agent"),
      userDir: join(projectDir, "user-extensions"),
    };
    const untrustedLoader = new ExtensionLoader(isolate);
    const untrusted = await untrustedLoader.loadAll();
    assert.equal(untrusted[0].status, "skipped");
    assert.match(untrusted[0].error ?? "", /not trusted/);

    const trustedLoader = new ExtensionLoader({
      ...isolate,
      trustedProjects: [projectDir],
    });
    const trusted = await trustedLoader.loadAll();
    assert.equal(trusted[0].status, "loaded");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("reports missing factories", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "nofactory.js"), "export const value = 1;\n");
    const loader = new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "error");
    assert.match(loaded[0].error ?? "", /default or activate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips denied project extensions with a denial message", async () => {
  const projectDir = tempDir();
  try {
    const extensionDir = join(projectDir, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "project.js"), "export default () => {};\n");

    const loader = new ExtensionLoader({
      projectDir,
      agentDir: join(projectDir, "agent"),
      userDir: join(projectDir, "user-extensions"),
      deniedProjects: [projectDir],
    });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "skipped");
    assert.match(loaded[0].error ?? "", /denied/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("reports discovered entries that were never loaded", () => {
  const projectDir = tempDir();
  try {
    const extensionDir = join(projectDir, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "project.js"), "export default () => {};\n");

    const loader = new ExtensionLoader({
      projectDir,
      agentDir: join(projectDir, "agent"),
      userDir: join(projectDir, "user-extensions"),
    });
    const report = loader.report();
    assert.equal(report.length, 1);
    assert.equal(report[0].source, "project");
    assert.equal(report[0].trusted, false);
    assert.equal(report[0].status, "skipped");
    assert.match(report[0].error ?? "", /not trusted/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
