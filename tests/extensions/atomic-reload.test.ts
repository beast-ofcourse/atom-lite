// Contract tests for ticket 08 (atomic reload).
//
// Seam under test: ExtensionLoader.stageExtensions()/commitStaged(). The TUI
// reload command is a thin orchestrator; all-or-nothing lives in the loader.
// Each test names the failure it pins: a partial swap, a leaked old handler, a
// stale lifecycle log, or a failed stage that disturbs the live set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { collectExtensionTools } from "../../dist/extensions/tool-adapter.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-atomic-reload-"));
}

function makeLoader(dir: string): ExtensionLoader {
  return new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
}

function toolNames(loader: ExtensionLoader): string[] {
  return collectExtensionTools(loader)
    .map((tool) => tool.definition.name)
    .sort();
}

function commandNames(loader: ExtensionLoader): string[] {
  return [...loader.list()[0].registries.commands.keys()].sort();
}

const V1 = [
  "export default (api) => {",
  "  api.registerTool({ name: 'old-tool', label: 'o', description: 'd', execute: async () => 'old' });",
  "  api.registerCommand({ name: 'old-command', run: async () => {} });",
  "};",
  "",
].join("\n");

const V2 = [
  "export default (api) => {",
  "  api.registerTool({ name: 'new-tool', label: 'n', description: 'd', execute: async () => 'new' });",
  "  api.registerCommand({ name: 'new-command', run: async () => {} });",
  "};",
  "",
].join("\n");

test("successful reload of an edited fixture swaps tools and commands in one commit", async () => {
  const dir = tempDir();
  const file = join(dir, "ext.js");
  try {
    writeFileSync(file, V1);
    const loader = makeLoader(dir);
    await loader.loadAll();
    assert.deepEqual(toolNames(loader), ["old-tool"]);
    assert.deepEqual(commandNames(loader), ["old-command"]);

    writeFileSync(file, V2);
    const staged = await loader.stageExtensions();

    // Staging builds the replacement aside; the old set stays live until commit.
    assert.deepEqual(toolNames(loader), ["old-tool"]);
    assert.deepEqual(commandNames(loader), ["old-command"]);

    loader.commitStaged(staged);
    assert.deepEqual(toolNames(loader), ["new-tool"]);
    assert.deepEqual(commandNames(loader), ["new-command"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed reload keeps the old tool and command set live and reports the error in doctor", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "ext.js"), V1);
    const loader = makeLoader(dir);
    await loader.loadAll();
    const toolsBefore = toolNames(loader);
    const commandsBefore = commandNames(loader);

    const originalDiscover = (loader as any).discover.bind(loader);
    (loader as any).discover = () => {
      throw new Error("reload exploded");
    };
    let caught: unknown;
    try {
      await loader.stageExtensions();
    } catch (error) {
      caught = error;
    } finally {
      (loader as any).discover = originalDiscover;
    }
    assert.match(String(caught), /reload exploded/);

    // The app reports a top-level failure the same way as a startup failure.
    loader.reportTopLevelError(caught, "loadAll");

    assert.deepEqual(toolNames(loader), toolsBefore);
    assert.deepEqual(commandNames(loader), commandsBefore);
    assert.match(loader.doctor(), /reload exploded/);
    assert.ok(
      loader
        .lifecycleEvents()
        .some(
          (event) =>
            event.type === "extension_error" &&
            event.method === "loadAll" &&
            /reload exploded/.test(event.error ?? ""),
        ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("previous generation handlers still fire during staging before the swap", async () => {
  const dir = tempDir();
  const marker = join(dir, "shutdown-fired");
  const file = join(dir, "ext.js");
  try {
    writeFileSync(
      file,
      [
        'import { writeFileSync } from "node:fs";',
        "export default (api) => {",
        `  api.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "fired"));`,
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const handlers = loader
      .list()[0]
      .registries.handlers.get("session_shutdown");
    assert.ok(handlers && handlers.size === 1);
    const oldHandler = [...handlers][0];

    writeFileSync(file, "export default () => {};\n");
    await loader.stageExtensions();

    // /reload emits session_shutdown on the outgoing set while staging is
    // complete but before the swap; that handler must not be treated as stale.
    await oldHandler(
      { type: "session_shutdown", reason: "reload" },
      loader.list()[0].context!,
    );
    assert.equal(existsSync(marker), true, "old shutdown handler was skipped");
    assert.equal(
      loader.lifecycleEvents().some((event) => event.phase === "stale"),
      false,
      "old handler was reported stale before the swap",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handler from the previous generation cannot fire after the swap", async () => {
  const dir = tempDir();
  const marker = join(dir, "old-handler-fired");
  const file = join(dir, "ext.js");
  try {
    writeFileSync(
      file,
      [
        'import { writeFileSync } from "node:fs";',
        "export default (api) => {",
        `  api.on("session_end", () => writeFileSync(${JSON.stringify(marker)}, "fired"));`,
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const oldHandlers = loader.list()[0].registries.handlers.get("session_end");
    assert.ok(oldHandlers && oldHandlers.size === 1);
    const oldHandler = [...oldHandlers][0];
    const oldContext = loader.list()[0].context!;

    writeFileSync(file, "export default () => {};\n");
    const staged = await loader.stageExtensions();
    loader.commitStaged(staged);

    await oldHandler({ type: "session_end" }, oldContext);
    assert.equal(existsSync(marker), false, "old-generation handler fired");
    assert.ok(
      loader.lifecycleEvents().some((event) => event.phase === "stale"),
      "stale handler was not reported",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful reload clears the previous lifecycle log", async () => {
  const dir = tempDir();
  const file = join(dir, "ext.js");
  try {
    writeFileSync(
      file,
      'export default () => { throw new Error("old boom"); };\n',
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    assert.ok(
      loader
        .lifecycleEvents()
        .some((event) => /old boom/.test(event.error ?? "")),
    );

    writeFileSync(file, "export default () => {};\n");
    const staged = await loader.stageExtensions();
    loader.commitStaged(staged);
    assert.equal(
      loader
        .lifecycleEvents()
        .some((event) => /old boom/.test(event.error ?? "")),
      false,
      "old lifecycle error survived the reload",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
