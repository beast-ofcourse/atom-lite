import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BANNER_LINES, Banner } from "../../dist/cli/banner.js";
import { ansiTheme, darkTheme } from "../../dist/cli/theme.js";

test("banner renders a centered themed wordmark", () => {
  const rows = new Banner(darkTheme).render(100);
  assert.equal(rows.length, BANNER_LINES.length);
  const tokenized = darkTheme.tokens.banner("x");
  const prefix = tokenized.slice(0, tokenized.indexOf("x"));
  const suffix = tokenized.slice(tokenized.indexOf("x") + 1);
  assert.ok(rows.every((row) => row.includes(prefix) && row.endsWith(suffix)));

  const firstWidth = visibleWidth(BANNER_LINES[0]);
  const expectedPad = Math.floor((100 - firstWidth) / 2);
  assert.ok(rows[0].startsWith(" ".repeat(expectedPad)));
});

test("no-colour banner emits no escape sequences", () => {
  for (const row of new Banner(ansiTheme).render(100)) {
    assert.equal(stripTerminalSequences(row), row);
  }
});

test("banner truncates instead of overflowing a narrow terminal", () => {
  for (const row of new Banner().render(24)) {
    assert.ok(visibleWidth(row) <= 24, `width ${visibleWidth(row)}`);
  }
});
