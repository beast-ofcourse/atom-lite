// Contract tests for ticket 11 (durable extension store).
//
// Seams under test:
//   - ExtensionStore: a namespaced JSON file under <agentDir>/extension-state,
//     explicit versions, a one-shot migration hook, a 1 MiB cap, and archival.
//   - ExtensionLoader/createExtensionAPI: an extension reconstructs state from
//     pi.store after restart/reload, a future version is a typed activation
//     failure, and doctor reports count/version without values.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_STORE_MAX_BYTES,
  ExtensionStore,
} from "../../dist/extensions/store.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";

function fixture(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.js`), `${body}\n`);
}

function storeDir(agentDir: string, id: string): string {
  return join(agentDir, "extension-state", `${id}.json`);
}

test("ExtensionStore persists JSON entries across instances and scopes by id", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-"));
  try {
    const agent = join(root, "agent");
    const first = new ExtensionStore({ id: "alpha", agentDir: agent });
    first.set("count", 1);
    first.set("nested", { ok: [true, null] });

    const second = new ExtensionStore({ id: "alpha", agentDir: agent });
    assert.equal(second.get("count"), 1);
    assert.deepEqual(second.get("nested"), { ok: [true, null] });
    second.delete("count");
    assert.equal(second.get("count"), undefined);

    const other = new ExtensionStore({ id: "beta", agentDir: agent });
    assert.equal(other.get("nested"), undefined, "ids are isolated");
    other.set("own", true);
    assert.ok(existsSync(storeDir(agent, "alpha")));
    assert.ok(existsSync(storeDir(agent, "beta")));
    assert.equal(
      JSON.parse(readFileSync(storeDir(agent, "alpha"), "utf8")).value.own,
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ExtensionStore runs migrate once when the stored version is older", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-migrate-"));
  try {
    const agent = join(root, "agent");
    mkdirSync(join(agent, "extension-state"), { recursive: true });
    writeFileSync(
      storeDir(agent, "app"),
      JSON.stringify({ version: 1, value: { n: 1 } }),
    );

    let calls = 0;
    const store = new ExtensionStore({ id: "app", agentDir: agent });
    store.version = 2;
    store.migrate = (oldVersion, value) => {
      calls++;
      assert.equal(oldVersion, 1);
      return { ...(value as Record<string, number>), n: value.n + 1 };
    };
    store.activate();
    store.activate();
    assert.equal(calls, 1);
    assert.equal(store.get("n"), 2);
    const persisted = JSON.parse(readFileSync(storeDir(agent, "app"), "utf8"));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.value.n, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ExtensionStore rejects a newer stored version with a typed error", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-future-"));
  try {
    const agent = join(root, "agent");
    mkdirSync(join(agent, "extension-state"), { recursive: true });
    writeFileSync(
      storeDir(agent, "app"),
      JSON.stringify({ version: 9, value: {} }),
    );
    const store = new ExtensionStore({ id: "app", agentDir: agent });
    store.version = 2;
    assert.throws(
      () => store.activate(),
      (error: any) => {
        assert.equal(error.name, "ExtensionCompatibilityError");
        assert.equal(error.method, "store.migrate");
        assert.match(error.message, /9/);
        assert.match(error.message, /2/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ExtensionStore enforces the 1 MiB cap with a typed error", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-cap-"));
  try {
    const store = new ExtensionStore({
      id: "big",
      agentDir: join(root, "agent"),
    });
    assert.ok(EXTENSION_STORE_MAX_BYTES > 0);
    assert.throws(
      () => store.set("blob", "x".repeat(EXTENSION_STORE_MAX_BYTES)),
      (error: any) => {
        assert.equal(error.name, "ExtensionCompatibilityError");
        assert.equal(error.method, "store.set");
        return true;
      },
    );
    assert.equal(store.get("blob"), undefined, "rejected write leaves no data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ExtensionStore archives instead of deleting and overwrites the archive", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-archive-"));
  try {
    const agent = join(root, "agent");
    const file = storeDir(agent, "app");
    const store = new ExtensionStore({ id: "app", agentDir: agent });
    store.set("a", 1);
    store.archive();
    assert.equal(existsSync(file), false);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")).value, {
      a: 1,
    });

    store.set("b", 2);
    store.archive();
    assert.deepEqual(
      JSON.parse(readFileSync(`${file}.bak`, "utf8")).value,
      { b: 2 },
      "a later archive replaces the previous one",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ExtensionStore info reports count and version, never values", () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-info-"));
  try {
    const store = new ExtensionStore({
      id: "app",
      agentDir: join(root, "agent"),
    });
    store.set("secret", "do-not-print");
    store.set("other", 7);
    assert.deepEqual(store.info(), { entryCount: 2, version: 1 });
    assert.doesNotMatch(JSON.stringify(store.info()), /do-not-print/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension state survives restart and reload without module globals", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-reload-"));
  try {
    const extDir = join(root, "ext");
    const marker = join(root, "seen.json");
    const agentDir = join(root, "agent");
    fixture(
      extDir,
      "counter",
      [
        'import { writeFileSync } from "node:fs";',
        `const MARKER = ${JSON.stringify(marker)};`,
        "export default (pi) => {",
        "  const seen = pi.store.get('seen') ?? 0;",
        "  pi.store.set('seen', seen + 1);",
        "  writeFileSync(MARKER, JSON.stringify({ seen }));",
        "};",
      ].join("\n"),
    );

    const first = new ExtensionLoader({ userDir: extDir, agentDir });
    await first.loadAll();
    assert.equal(first.loadedExtensions().length, 1, "fixture activated");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).seen, 0);
    assert.equal(
      JSON.parse(readFileSync(storeDir(agentDir, "counter"), "utf8")).value
        .seen,
      1,
    );

    // A reload re-evaluates the module with no shared globals. The value comes
    // only from the durable store.
    const second = new ExtensionLoader({ userDir: extDir, agentDir });
    await second.loadAll();
    assert.equal(second.loadedExtensions().length, 1, "reload activated");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).seen, 1);
    assert.equal(
      JSON.parse(readFileSync(storeDir(agentDir, "counter"), "utf8")).value
        .seen,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration runs once at activation across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-migrate-once-"));
  try {
    const extDir = join(root, "ext");
    const marker = join(root, "value.json");
    const migrations = join(root, "migrations.txt");
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "extension-state"), { recursive: true });
    writeFileSync(
      storeDir(agentDir, "migrate"),
      JSON.stringify({ version: 1, value: { n: 1 } }),
    );
    fixture(
      extDir,
      "migrate",
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `const VALUE = ${JSON.stringify(marker)};`,
        `const MIGRATIONS = ${JSON.stringify(migrations)};`,
        "export default (pi) => {",
        "  pi.store.version = 2;",
        "  pi.store.migrate = (oldVersion, value) => {",
        "    appendFileSync(MIGRATIONS, 'x');",
        "    return { ...value, n: value.n + 1 };",
        "  };",
        "  writeFileSync(VALUE, JSON.stringify(pi.store.get('n')));",
        "};",
      ].join("\n"),
    );

    const first = new ExtensionLoader({ userDir: extDir, agentDir });
    await first.loadAll();
    assert.equal(first.loadedExtensions().length, 1, "fixture activated");
    assert.ok(existsSync(migrations));
    assert.equal(readFileSync(migrations, "utf8"), "x");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")), 2);

    const second = new ExtensionLoader({ userDir: extDir, agentDir });
    await second.loadAll();
    assert.equal(readFileSync(migrations, "utf8"), "x", "not migrated twice");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a future stored version fails activation with a typed error", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-future-loader-"));
  try {
    const extDir = join(root, "ext");
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "extension-state"), { recursive: true });
    writeFileSync(
      storeDir(agentDir, "future"),
      JSON.stringify({ version: 9, value: {} }),
    );
    fixture(
      extDir,
      "future",
      [
        "export default (pi) => {",
        "  pi.store.version = 1;",
        "  pi.store.get('anything');",
        "};",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    await loader.loadAll();

    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "future");
    assert.equal(errors[0].method, "store.migrate");
    assert.match(errors[0].error ?? "", /ExtensionCompatibilityError|version/);
    assert.equal(loader.list()[0].status, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports store entry count and version, never values", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-doctor-"));
  try {
    const extDir = join(root, "ext");
    const agentDir = join(root, "agent");
    fixture(
      extDir,
      "doctor",
      [
        "export default (pi) => {",
        "  pi.store.set('secret', 'do-not-print');",
        "};",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    await loader.loadAll();
    assert.equal(loader.loadedExtensions().length, 1, "fixture activated");

    const [diagnostic] = JSON.parse(loader.doctorJson());
    assert.deepEqual(diagnostic.store, { entryCount: 1, version: 1 });
    assert.doesNotMatch(loader.doctorJson(), /do-not-print/);
    assert.doesNotMatch(loader.doctor(), /do-not-print/);
    assert.match(loader.doctor(), /1 store entries v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loader archives an extension's store on unregister", async () => {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-unregister-"));
  try {
    const extDir = join(root, "ext");
    const agentDir = join(root, "agent");
    fixture(
      extDir,
      "unregister",
      "export default (pi) => { pi.store.set('k', 'v'); };\n",
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    await loader.loadAll();
    const file = storeDir(agentDir, "unregister");
    assert.ok(existsSync(file));

    loader.archiveStore("unregister");
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(`${file}.bak`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unloadAll archives durable state through the host unload path", async () => {
  // Regression: archiveStore existed but no host path called it, so removing
  // an extension left its state file behind instead of a .bak snapshot.
  const root = mkdtempSync(join(tmpdir(), "atom-lite-store-unload-all-"));
  try {
    const extDir = join(root, "ext");
    const agentDir = join(root, "agent");
    fixture(
      extDir,
      "unloaded",
      "export default (pi) => { pi.store.set('k', 'v'); };\n",
    );
    const loader = new ExtensionLoader({ userDir: extDir, agentDir });
    await loader.loadAll();
    const file = storeDir(agentDir, "unloaded");
    assert.ok(existsSync(file));

    await loader.unloadAll();

    assert.deepEqual(loader.list(), []);
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(`${file}.bak`));
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")).value, {
      k: "v",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
