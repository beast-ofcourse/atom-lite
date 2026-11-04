import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolBox, formatToolArgs } from "../../dist/cli/tool-box.js";

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

test("tool call and live output use separate coloured panels", () => {
  const box = new ToolBox({
    id: "1",
    name: "bash",
    args: { command: "npm test" },
  });
  box.appendLive("running tests\nPASS one\n");
  const rows = box.render(60);
  const rendered = rows.join("\n");
  assert.match(rendered, /bash · running/);
  assert.match(rendered, /\$ npm test/);
  assert.match(rendered, /output · live/);
  assert.ok(rendered.includes(CYAN), "call panel is cyan");
  assert.ok(rendered.includes(YELLOW), "live output panel is yellow");
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 60, `width ${visibleWidth(row)}`);
  }
});

test("successful and failed results colour the output panel differently", () => {
  const ok = new ToolBox({ id: "1", name: "read", args: { path: "a.ts" } });
  ok.setResult("line one\nline two");
  const okRows = ok.render(60);
  assert.ok(okRows.join("\n").includes(GREEN));
  assert.match(okRows.join("\n"), /2 lines · ctrl\+o to expand/);

  ok.setExpanded(true);
  assert.match(ok.render(60).join("\n"), /line one/);

  const bad = new ToolBox({
    id: "2",
    name: "bash",
    args: { command: "false" },
  });
  bad.setResult("boom", { isError: true });
  const badRendered = bad.render(60).join("\n");
  assert.ok(badRendered.includes(RED));
  assert.match(badRendered, /✗ bash/);
});

test("diff results summarise or expand with coloured lines", () => {
  const box = new ToolBox({ id: "1", name: "edit", args: { path: "a.ts" } });
  box.setResult("", {
    diff: ["--- a/a.ts", "+++ b/a.ts", "+added", "-removed"],
  });
  assert.match(box.render(60).join("\n"), /\+2 -2 · ctrl\+o to expand/);

  box.setExpanded(true);
  const rendered = box.render(60).join("\n");
  assert.ok(rendered.includes(GREEN));
  assert.ok(rendered.includes(RED));
  assert.match(rendered, /\+added/);
});

test("formatToolArgs picks the useful argument for common tools", () => {
  assert.equal(formatToolArgs("bash", { command: "ls\n-la" }), "$ ls -la");
  assert.equal(formatToolArgs("read", { path: "src/a.ts" }), "path: src/a.ts");
  assert.equal(
    formatToolArgs("webfetch", { url: "https://example.com" }),
    "url: https://example.com",
  );
  assert.equal(formatToolArgs("write", {}), "");
});
