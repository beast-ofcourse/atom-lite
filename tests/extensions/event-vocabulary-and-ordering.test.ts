// Contract tests for ticket 06 (event vocabulary and ordering).
//
// Seams under test:
//   - ExtensionLoader.loadAll()/lifecycleEvents(): lifecycle event order and
//     sibling broadcast. Catches load/activate inversion and lost broadcasts;
//     misses TUI-level dispatch ordering.
//   - AgentRuntime with FakeProvider and TurnRecorder.extensionDispatch: the
//     typed turn vocabulary and awaited handler completion. Catches missing
//     events and fire-and-forget dispatch in the agent loop.
//   - ExtensionLoader.dispatchEvent(): host-owned events reach subscribers and
//     awaited handlers settle before dispatch resolves. Catches a dropped event
//     or a reintroduced fire-and-forget path without inspecting source text.
//
// Each test names the failure it pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { TurnRecorder } from "../../dist/agent/turn-recorder.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { bashTool } from "../../dist/tools/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-events-"));
}

test("a fake turn emits every typed turn event", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.txt"), "hi\n");
    const provider = new FakeProvider([
      {
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "echo hi" } },
        ],
      },
      { text: "done" },
    ]);
    const seen = new Set<string>();
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [bashTool],
      mode: "yolo",
      extensionDispatch: async (event) => {
        seen.add(event);
        return [];
      },
    });
    const session = new InMemorySession("s1", dir);
    await runtime.runAgentTurn("go", session, new AbortController().signal);

    for (const name of [
      "turn_start",
      "context_build",
      "before_provider_request",
      "after_provider_response",
      "message_start",
      "message_end",
      "tool_call",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "tool_result",
      "turn_end",
      "agent_before_settle",
      "agent_settled",
    ]) {
      assert.ok(seen.has(name), `turn did not emit ${name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("message_start handler settles before the assistant message is recorded", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const appended: unknown[] = [];
  const recorder = new TurnRecorder({
    session: { appendMessage: (message) => appended.push(message) },
    extensionDispatch: async (event) => {
      if (event === "message_start") {
        started();
        await gate;
      }
      return [];
    },
  });

  const pending = recorder.recordAssistant(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      } as any,
    },
    "hi",
  );
  await startedPromise;
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(
    settled,
    false,
    "recordAssistant advanced while message_start handler was pending",
  );

  release();
  await pending;
  assert.equal(appended.length, 1);
});

test("tool_execution_update handler settles before the turn advances", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.txt"), "hi\n");
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new FakeProvider([
      {
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "echo hi" } },
        ],
      },
      { text: "done" },
    ]);
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [bashTool],
      mode: "yolo",
      extensionDispatch: async (event) => {
        if (event === "tool_execution_update") {
          started();
          await gate;
        }
        return [];
      },
    });
    const session = new InMemorySession("s1", dir);
    const pending = runtime.runAgentTurn(
      "go",
      session,
      new AbortController().signal,
    );

    await startedPromise;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      settled,
      false,
      "turn advanced while tool_execution_update handler was pending",
    );

    release();
    assert.equal(await pending, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension_load is delivered before extension_activate, once per recipient", async () => {
  const dir = tempDir();
  const logA = join(dir, "a.log");
  const logB = join(dir, "b.log");
  try {
    const handler = (log: string) =>
      [
        'import { appendFileSync } from "node:fs";',
        `const log = ${JSON.stringify(log)};`,
        "export default (api) => {",
        '  api.on("extension_load", (event) => appendFileSync(log, `${event.extensionId}:load\\n`));',
        '  api.on("extension_activate", (event) => appendFileSync(log, `${event.extensionId}:activate\\n`));',
        "};",
        "",
      ].join("\n");
    writeFileSync(join(dir, "a.js"), handler(logA));
    writeFileSync(join(dir, "b.js"), handler(logB));

    const ordered: string[] = [];
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
      onLifecycleEvent: (event) => {
        if (
          event.type === "extension_load" ||
          event.type === "extension_activate"
        ) {
          ordered.push(`${event.extensionId}:${event.type}`);
        }
      },
    });
    await loader.loadAll();

    assert.deepEqual(ordered, [
      "a:extension_load",
      "a:extension_activate",
      "b:extension_load",
      "b:extension_activate",
    ]);
    const lines = (path: string) =>
      readFileSync(path, "utf8").trim().split("\n");
    assert.deepEqual(lines(logA), [
      "a:load",
      "a:activate",
      "b:load",
      "b:activate",
    ]);
    assert.deepEqual(lines(logB), [
      "a:load",
      "a:activate",
      "b:load",
      "b:activate",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sibling extension receives extension_error exactly once after commit", async () => {
  const dir = tempDir();
  const log = join(dir, "errors.log");
  try {
    writeFileSync(
      join(dir, "a-boom.js"),
      'export default () => { throw new Error("activation exploded"); };\n',
    );
    writeFileSync(
      join(dir, "b-watch.js"),
      [
        'import { appendFileSync } from "node:fs";',
        `const log = ${JSON.stringify(log)};`,
        "export default (api) => {",
        '  api.on("extension_error", (event) => appendFileSync(log, `${event.error ?? ""}\\n`));',
        "};",
        "",
      ].join("\n"),
    );

    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    assert.equal(loader.list().find((e) => e.id === "a-boom")?.status, "error");
    assert.equal(loader.loadedExtensions().length, 1);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "activation exploded",
    ]);
    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].extensionId, "a-boom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every host-owned event reaches a subscribed handler through dispatch", async () => {
  // Behavioural contract for ticket 06: the host events the agent loop does
  // not emit must still reach subscribers through the real dispatch seam.
  const dir = tempDir();
  const log = join(dir, "host-events.log");
  const hostEvents = [
    "session_start",
    "session_shutdown",
    "config_change",
    "session_end",
  ];
  try {
    writeFileSync(
      join(dir, "watcher.js"),
      [
        'import { appendFileSync } from "node:fs";',
        `const log = ${JSON.stringify(log)};`,
        "export default (api) => {",
        `  for (const type of ${JSON.stringify(hostEvents)}) {`,
        "    api.on(type, (event) => appendFileSync(log, `${event.type}\\n`));",
        "  }",
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();
    for (const type of hostEvents.slice(0, 3) as any[]) {
      await loader.dispatchEvent(type, { type });
    }
    await loader.notifySessionEnd();

    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), hostEvents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow config_change handler settles before dispatch resolves", async () => {
  // Behavioural replacement for the fire-and-forget source scan: a pending
  // handler must hold the dispatch open, not leak into a later turn.
  const dir = tempDir();
  const marker = join(dir, "settled");
  try {
    writeFileSync(
      join(dir, "slow.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker)};`,
        "export default (api) => {",
        "  api.on('config_change', async () => {",
        "    await new Promise((resolve) => setTimeout(resolve, 15));",
        '    writeFileSync(marker, "done");',
        "  });",
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    await loader.dispatchEvent("config_change", { type: "config_change" });
    assert.equal(
      readFileSync(marker, "utf8"),
      "done",
      "dispatch resolved before the handler settled",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
