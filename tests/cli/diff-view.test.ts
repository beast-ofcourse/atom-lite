import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffView } from "../../dist/cli/diff-view.js";
import { GREEN, RED } from "../../dist/cli/panel.js";

test("DiffView renders added and removed lines with colors", () => {
  const view = new DiffView({
    lines: ["--- a/a.ts", "+++ b/a.ts", "+added", "-removed"],
    path: "a.ts",
  });
  const rendered = view.render(60).join("\n");
  assert.ok(rendered.includes(GREEN));
  assert.ok(rendered.includes(RED));
  assert.match(rendered, /\+added/);
  assert.match(rendered, /-removed/);
  assert.match(rendered, /a\.ts/);
});

test("DiffView truncates large diffs", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `+ line ${i}`);
  const view = new DiffView({ lines, maxLines: 10 });
  const rendered = view.render(60).join("\n");
  assert.match(rendered, /more lines truncated/);
});
