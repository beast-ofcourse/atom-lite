import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Footer } from "../../dist/cli/footer.js";
import { darkTheme } from "../../dist/cli/theme.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

function render(parts: Record<string, unknown>, width: number) {
  const f = new Footer(darkTheme);
  f.setParts(parts);
  return f.render(width);
}

test("footer renders context percentage against the window", () => {
  const rows = render(
    {
      pwd: "/tmp",
      used: 1220,
      window: 1000000,
      percent: 0.122,
      model: "p/m",
      autoCompact: true,
    },
    80,
  );
  const plain = rows.map(stripTerminalSequences);
  assert.ok(plain[1].includes("0.1%/1.0M (auto)"));
});

test("footer renders unknown context as question mark", () => {
  const rows = render(
    {
      pwd: "/tmp",
      used: undefined,
      window: 1000000,
      percent: null,
      model: "p/m",
      autoCompact: true,
    },
    80,
  );
  const plain = rows.map(stripTerminalSequences);
  assert.ok(plain[1].includes("?/1.0M (auto)"));
});

test("footer keeps rows within width", () => {
  const rows = render(
    {
      pwd: "/tmp",
      used: 100,
      window: 200000,
      percent: 0.05,
      model: "p/m",
      autoCompact: true,
    },
    40,
  );
  for (const r of rows) assert.ok(visibleWidth(r) <= 40);
});

test("footer reflects a driven agent turn's context usage", async () => {
  const os = await import("node:os");
  const dir = os.tmpdir();
  const provider = new FakeProvider([
    { text: "done", usage: { input: 1000, output: 20 } },
  ]);
  const runtime = new AgentRuntime({
    provider,
    workspace: dir,
    tools: [],
    contextWindow: 50000,
    onEvent: () => {},
  });
  await runtime.runAgentTurn(
    "hi",
    new InMemorySession("s", dir),
    new AbortController().signal,
  );
  const usage = runtime.getContextUsage();
  const footer = new Footer(darkTheme);
  footer.setParts({
    pwd: dir,
    used: usage.used,
    window: usage.window,
    percent: usage.percent,
    model: "fake/model",
    autoCompact: true,
  });
  const plain = footer.render(80).map(stripTerminalSequences);
  assert.ok(plain[1].includes("/50k (auto)"));
  assert.ok(plain[1].includes("fake/model"));
});
