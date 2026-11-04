import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { readTool } from "../../dist/tools/index.js";

test("context usage reports the latest response, not cumulative totals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const provider = new FakeProvider([
    {
      toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }],
      usage: { input: 1000, output: 10 },
    },
    { text: "done", usage: { input: 1200, output: 20 } },
  ]);
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [readTool],
    contextWindow: 1_000_000,
    onEvent: (e) => events.push(e),
  });
  await runtime.runAgentTurn(
    "read",
    new InMemorySession("s", dir),
    new AbortController().signal,
  );

  assert.deepEqual(runtime.getContextUsage(), {
    used: 1220,
    window: 1_000_000,
  });
  const usageEvents = events.filter((e) => e.type === "context_usage");
  assert.equal(usageEvents.at(-1).used, 1220);
  assert.equal(usageEvents.at(-1).window, 1_000_000);
});

test("switching models clears stale context usage and accepts a new window", () => {
  const events: any[] = [];
  const runtime = new AgentRuntime({
    provider: new FakeProvider([]),
    tools: [],
    contextWindow: 128_000,
    onEvent: (e) => events.push(e),
  });
  runtime.switchModel(new FakeProvider([]), "next-model");
  assert.deepEqual(runtime.getContextUsage(), {
    used: undefined,
    window: 128_000,
  });

  runtime.setContextWindow(1_000_000);
  assert.deepEqual(runtime.getContextUsage(), {
    used: undefined,
    window: 1_000_000,
  });
  assert.ok(
    events.some(
      (e) =>
        e.type === "context_usage" &&
        e.used === undefined &&
        e.window === 1_000_000,
    ),
  );
});
