// Contract tests for ticket 05 (error boundaries).
//
// Seams under test:
//   - ExtensionLoader.notifySessionEnd()/lifecycleEvents()/doctor(): an async
//     lifecycle handler rejection is contained and recorded once with the
//     owning extension id, the event/method name, and a stack.
//   - ExtensionBoundary.run(): a per-handler timeout and a reload generation
//     token contain a hang and a stale handler respectively.
//   - CommandRegistry.dispatch(): a rejecting command is contained and
//     surfaced on a user-visible line instead of becoming an unhandled
//     rejection.
//   - DialogBoundary: a pending select/confirm/input promise rejects when its
//     overlay is torn down rather than hanging the turn.
//
// Each test names the failure it pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { CommandRegistry } from "../../dist/cli/commands.js";
import { DialogBoundary } from "../../dist/extensions/ui.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-boundary-"));
}

function makeLoader(
  dir: string,
  options: {
    handlerTimeoutMs?: number;
    onLifecycleEvent?: (event: any) => void;
  } = {},
): ExtensionLoader {
  return new ExtensionLoader({
    userDir: dir,
    agentDir: join(dir, "agent"),
    ...options,
  });
}

test("async lifecycle rejection is contained, attributed, and appears once in doctor", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "async-reject.js"),
      [
        "export default (api) => {",
        '  api.on("session_end", async () => { throw new Error("async boom"); });',
        "};",
        "",
      ].join("\n"),
    );
    const observed: any[] = [];
    const loader = makeLoader(dir, {
      onLifecycleEvent: (event) => observed.push(event),
    });
    await loader.loadAll();

    // The dispatch is awaited, so by the time this resolves the failure has
    // been recorded and no unhandled rejection remains.
    await loader.notifySessionEnd();

    const errors = loader
      .lifecycleEvents()
      .filter((e) => e.type === "extension_error");
    assert.equal(errors.length, 1, "exactly one error record");
    assert.equal(errors[0].extensionId, "async-reject");
    assert.equal(errors[0].method, "on:session_end");
    assert.match(errors[0].error ?? "", /async boom/);
    assert.match(errors[0].stack ?? "", /async boom/);

    const observedErrors = observed.filter((e) => e.type === "extension_error");
    assert.equal(observedErrors.length, 1);
    assert.equal(observedErrors[0].extensionId, "async-reject");
    assert.match(observedErrors[0].error ?? "", /async boom/);

    const doctor = loader.doctor();
    assert.match(doctor, /async-reject/);
    assert.match(doctor, /on:session_end/);
    assert.match(doctor, /async boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handler that never settles is timed out instead of hanging the turn", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "hang.js"),
      'export default (api) => { api.on("session_end", () => new Promise(() => {})); };\n',
    );
    const loader = makeLoader(dir, { handlerTimeoutMs: 25 });
    await loader.loadAll();

    await loader.notifySessionEnd();

    const errors = loader
      .lifecycleEvents()
      .filter((e) => e.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "hang");
    assert.equal(errors[0].method, "on:session_end");
    assert.equal(errors[0].phase, "timeout");
    assert.match(loader.doctor(), /timeout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handler retained from a previous generation is stale after reload", async () => {
  const dir = tempDir();
  const marker1 = join(dir, "marker1");
  const marker2 = join(dir, "marker2");
  try {
    writeFileSync(
      join(dir, "a-first.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker1)};`,
        'export default (api) => { api.on("session_end", () => writeFileSync(marker, "ran")); };',
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const staleHandler = [
      ...loader.list()[0].registries.handlers.get("session_end")!,
    ][0];

    // Swap to a new generation with a different extension.
    rmSync(join(dir, "a-first.js"));
    writeFileSync(
      join(dir, "b-second.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker2)};`,
        'export default (api) => { api.on("session_end", () => writeFileSync(marker, "ran")); };',
        "",
      ].join("\n"),
    );
    await loader.loadAll();

    // A reference held from the old generation must not mutate the new set.
    await (staleHandler as any)({ type: "session_end" }, null);
    assert.equal(existsSync(marker1), false, "stale handler ran");

    // The current generation still works, so the turn remains usable.
    await loader.notifySessionEnd();
    assert.equal(existsSync(marker2), true, "current handler did not run");

    const errors = loader
      .lifecycleEvents()
      .filter((e) => e.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "a-first");
    assert.equal(errors[0].phase, "stale");
    assert.match(errors[0].method ?? "", /on:session_end/);
    assert.match(loader.doctor(), /stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejecting command is contained and surfaced on a user-visible line", async () => {
  const lines: string[] = [];
  const ctx: any = { appendLine: (text: string) => lines.push(text) };
  const registry = new CommandRegistry();
  registry.register({
    name: "async-boom",
    description: "",
    category: "Test",
    async run() {
      throw new Error("async command boom");
    },
  });
  registry.register({
    name: "sync-boom",
    description: "",
    category: "Test",
    run() {
      throw new Error("sync command boom");
    },
  });

  const asyncResult = await registry.dispatch("/async-boom", ctx);
  const syncResult = await registry.dispatch("/sync-boom", ctx);

  assert.equal(asyncResult.handled, true);
  assert.match(asyncResult.error ?? "", /async command boom/);
  assert.equal(syncResult.handled, true);
  assert.match(syncResult.error ?? "", /sync command boom/);
  assert.ok(
    lines.some((line) => /async command boom/.test(line)),
    "async command failure shown to the user",
  );
  assert.ok(
    lines.some((line) => /sync command boom/.test(line)),
    "sync command failure shown to the user",
  );
});

test("a pending dialog promise rejects when its overlay is torn down", async () => {
  const boundary = new DialogBoundary();
  let settle!: (value: string) => void;
  const pending = boundary.run<string>("select", ({ resolve }) => {
    settle = resolve;
  });
  assert.equal(boundary.size, 1);

  boundary.cancelAll("overlay closed");
  await assert.rejects(pending, /overlay closed/);
  assert.equal(boundary.size, 0, "settled dialogs are no longer pending");

  // A normally settled dialog is removed, so a later teardown is inert.
  let resolveConfirm!: (value: boolean) => void;
  const confirmed = boundary.run<boolean>("confirm", ({ resolve }) => {
    resolveConfirm = resolve;
  });
  resolveConfirm(true);
  assert.equal(await confirmed, true);
  assert.equal(boundary.size, 0);
  boundary.cancelAll("overlay closed");
});

test("closing the previous overlay does not cancel the dialog being opened", async () => {
  const boundary = new DialogBoundary();
  let settle!: (value: string) => void;
  const opened = boundary.run<string>("select", ({ resolve, reject }) => {
    // The app tears down the previous overlay as part of opening this one.
    boundary.cancelAll("previous overlay closed");
    settle = resolve;
    void reject;
  });
  assert.equal(boundary.size, 1, "the new dialog is tracked");
  settle("chosen");
  assert.equal(await opened, "chosen");
});

test("a rejected extension command is attributed in doctor with id, method, and stack", async () => {
  const dir = tempDir();
  try {
    const loader = makeLoader(dir);
    await loader.loadAll();

    await assert.rejects(
      loader.runBounded(
        { extensionId: "deploy", method: "command:/ship" },
        async () => {
          throw new Error("ship failed");
        },
        { rethrow: true },
      ),
      /ship failed/,
    );

    const errors = loader
      .lifecycleEvents()
      .filter((e) => e.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "deploy");
    assert.equal(errors[0].method, "command:/ship");
    assert.match(errors[0].stack ?? "", /ship failed/);
    const doctor = loader.doctor();
    assert.match(doctor, /deploy/);
    assert.match(doctor, /command:\/ship/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
