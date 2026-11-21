import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Footer } from "../../dist/cli/footer.js";
import { darkTheme } from "../../dist/cli/theme.js";

function render(parts: any, width: number) {
  const f = new Footer(darkTheme);
  f.setParts(parts);
  return f.render(width);
}

test("footer renders context percentage against the window", () => {
  const rows = render(
    { pwd: "/tmp", used: 1220, window: 1000000, percent: 0.122, model: "p/m", autoCompact: true },
    80,
  );
  const plain = rows.map(stripTerminalSequences);
  assert.ok(plain[1].includes("0.1%/1.0M (auto)"));
});

test("footer renders unknown context as question mark", () => {
  const rows = render(
    { pwd: "/tmp", used: undefined, window: 1000000, percent: null, model: "p/m", autoCompact: true },
    80,
  );
  const plain = rows.map(stripTerminalSequences);
  assert.ok(plain[1].includes("?/1.0M (auto)"));
});

test("footer keeps rows within width", () => {
  const rows = render(
    { pwd: "/tmp", used: 100, window: 200000, percent: 0.05, model: "p/m", autoCompact: true },
    40,
  );
  for (const r of rows) assert.ok(visibleWidth(r) <= 40);
});