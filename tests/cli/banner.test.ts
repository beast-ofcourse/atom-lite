import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BANNER_LINES, Banner } from "../../dist/cli/banner.js";

test("banner renders a centered bold-red wordmark", () => {
  const rows = new Banner().render(100);
  assert.equal(rows.length, BANNER_LINES.length);
  assert.ok(rows.every((row) => row.includes("\x1b[1;31m")));
  assert.ok(rows.every((row) => row.endsWith("\x1b[0m")));

  const firstWidth = visibleWidth(BANNER_LINES[0]);
  const expectedPad = Math.floor((100 - firstWidth) / 2);
  assert.ok(rows[0].startsWith(" ".repeat(expectedPad) + "\x1b[1;31m"));
});

test("banner truncates instead of overflowing a narrow terminal", () => {
  for (const row of new Banner().render(24)) {
    assert.ok(visibleWidth(row) <= 24, `width ${visibleWidth(row)}`);
  }
});
