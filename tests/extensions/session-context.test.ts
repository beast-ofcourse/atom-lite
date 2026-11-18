// Regression: extension session APIs returned placeholders ("current", an
// undefined manager) and entries vanished on resume. This pins the real
// session-manager wiring, durable appendEntry/getSessionEntries, and the bound
// on the lifecycle log across reloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
import { PiSessionManager } from "../../dist/extensions/session-manager.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";

function fixture(dir: string, marker: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ext.js"),
    [
      'import { writeFileSync } from "node:fs";',
      `const MARKER = ${JSON.stringify(marker)};`,
      body,
      "",
    ].join("\n"),
  );
}

test("PiSessionManager entries survive resume through the session store", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-sm-mgr-"));
  try {
    const store = new JsonlSessionStore({ rootDir: join(root, "sessions") });
    const session = store.create({
      workspace: root,
      provider: "fake",
      id: "s1",
    });
    const manager = new PiSessionManager({ session });
    assert.equal(manager.getId(), "s1");
    manager.appendEntry("mark", { v: 1 });
    await session.flush();

    const resumed = store.resume("s1");
    assert.ok(resumed, "durable session should be resumable");
    const restored = new PiSessionManager({ session: resumed! });
    assert.deepEqual(
      restored.getEntries().map((entry: any) => [entry.customType, entry.data]),
      [["mark", { v: 1 }]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension API exposes the real session id and a live session manager", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-sm-api-"));
  try {
    const extDir = join(root, "ext");
    const marker = join(root, "marker.json");
    fixture(
      extDir,
      marker,
      [
        "export default (api) => {",
        "  writeFileSync(MARKER, JSON.stringify({",
        "    id: api.getSession().id,",
        "    managerId: api.getSessionManager()?.getId?.(),",
        "  }));",
        "  api.appendEntry('loaded', { ok: true });",
        "};",
      ].join("\n"),
    );
    const store = new JsonlSessionStore({ rootDir: join(root, "sessions") });
    const session = store.create({
      workspace: root,
      provider: "fake",
      id: "s-real",
    });
    const loader = new ExtensionLoader({
      userDir: extDir,
      agentDir: join(root, "agent"),
      session,
    });
    await loader.loadAll();

    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.id, "s-real");
    assert.equal(observed.managerId, "s-real");
    await session.flush();

    const resumed = store.resume("s-real");
    assert.ok(resumed);
    const restored = new PiSessionManager({ session: resumed! });
    assert.ok(
      restored.getEntries().some((entry: any) => entry.customType === "loaded"),
      "entry appended during activation must persist",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSessionEntries reads persisted entries after resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-sm-resume-"));
  try {
    const store = new JsonlSessionStore({ rootDir: join(root, "sessions") });
    const session = store.create({
      workspace: root,
      provider: "fake",
      id: "s-resume",
    });

    const writerDir = join(root, "writer");
    fixture(
      writerDir,
      join(root, "unused.json"),
      [
        "export default (api) => {",
        "  api.appendEntry('note', { text: 'persisted' });",
        "};",
      ].join("\n"),
    );
    const writer = new ExtensionLoader({
      userDir: writerDir,
      agentDir: join(root, "agent"),
      session,
    });
    await writer.loadAll();
    await session.flush();

    const resumed = store.resume("s-resume");
    assert.ok(resumed);
    const readerDir = join(root, "reader");
    const marker = join(root, "entries.json");
    fixture(
      readerDir,
      marker,
      [
        "export default (api) => {",
        "  writeFileSync(MARKER, JSON.stringify(",
        "    api.getSessionEntries({ type: 'note' }).map((e) => [e.customType, e.data]),",
        "  ));",
        "};",
      ].join("\n"),
    );
    const reader = new ExtensionLoader({
      userDir: readerDir,
      agentDir: join(root, "agent"),
      session: resumed!,
    });
    await reader.loadAll();

    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), [
      ["note", { text: "persisted" }],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle log stays bounded after ten reloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-sm-log-"));
  try {
    const extDir = join(root, "ext");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "ext.js"), "export default () => {};\n");
    const loader = new ExtensionLoader({
      userDir: extDir,
      agentDir: join(root, "agent"),
      maxLifecycleEvents: 4,
    });
    for (let i = 0; i < 10; i++) await loader.loadAll();
    assert.ok(
      loader.lifecycleEvents().length <= 4,
      `lifecycle log grew to ${loader.lifecycleEvents().length}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
