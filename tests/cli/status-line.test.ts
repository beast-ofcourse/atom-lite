import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  StatusLine,
  type StatusLineParts,
} from "../../dist/cli/status-line.js";
import { ansiTheme, darkTheme, type Theme } from "../../dist/cli/theme.js";

function render(parts: StatusLineParts, width: number, theme?: Theme) {
  const status = new StatusLine(theme);
  status.setParts(parts);
  return status.render(width);
}

const PLAIN = {
  left: "kilo/kilo-auto/free",
  tokens: "tokens: 4.5k/256k",
  effort: "effort: medium",
};

test("status line puts tokens below provider/model and keeps effort on top", () => {
  const rows = render(PLAIN, 80, darkTheme);
  const plain = rows.map(stripTerminalSequences);
  assert.equal(rows.length, 2);
  assert.equal(visibleWidth(rows[0]), 80);
  assert.equal(visibleWidth(rows[1]), 80);
  assert.ok(plain[0].trimStart().startsWith("kilo/kilo-auto/free"));
  assert.ok(plain[0].trimEnd().endsWith("effort: medium"));
  assert.ok(plain[1].trimStart().startsWith("tokens: 4.5k/256k"));
});

test("status line shows the active persona beside the mode", () => {
  const rows = render({ ...PLAIN, agent: "reviewer", mode: "yolo" }, 100);
  const plain = rows.map(stripTerminalSequences);
  assert.match(plain[0], /agent:reviewer/);
  assert.match(plain[0], /mode:yolo/);
  assert.ok(plain[0].trimEnd().endsWith("effort: medium"));
});

test("status line colours parts through semantic theme tokens", () => {
  const rows = render(PLAIN, 60, darkTheme);
  assert.ok(rows[0].includes(darkTheme.tokens.status(PLAIN.left)));
  assert.ok(rows[0].includes(darkTheme.tokens.dim(PLAIN.effort)));
  assert.ok(rows[1].includes(darkTheme.tokens.dim(PLAIN.tokens)));
});

test("no-colour status line emits no escape sequences", () => {
  const rows = render(PLAIN, 60, ansiTheme);
  for (const row of rows) {
    assert.equal(stripTerminalSequences(row), row);
  }
});

test("status line truncates each row instead of overflowing a narrow terminal", () => {
  const rows = render(
    {
      left: "a-long-provider/model-name",
      tokens: "tokens: 999k/1000k",
      effort: "effort: medium",
    },
    20,
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 20, `width ${visibleWidth(row)}`);
  }
  assert.ok(stripTerminalSequences(rows[0]).includes("…"));
});
