import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ConfigWarning } from "../../dist/cli/config-warning.js";
import { ansiTheme } from "../../dist/cli/theme.js";

test("config warning renders nothing when the config is clean", () => {
  const warning = new ConfigWarning(ansiTheme);
  assert.equal(warning.hasMessages, false);
  assert.deepEqual(warning.render(80), []);
});

test("config warning shows the problem in a right-aligned panel", () => {
  const warning = new ConfigWarning(ansiTheme);
  warning.setMessages(['provider "main": model: expected string']);
  const rows = warning.render(80);
  assert.equal(warning.hasMessages, true);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^ +╭ config /);
  assert.match(rows[1], /provider "main": model: expected string/);
  for (const row of rows) assert.equal(visibleWidth(row), 80);
});

test("config warning summarizes extra problems and fits a narrow terminal", () => {
  const warning = new ConfigWarning(ansiTheme);
  warning.setMessages(["first problem", "second problem"]);
  const rows = warning.render(30);
  assert.equal(rows.length, 3);
  assert.match(rows[1], /first problem \(\+1 more\)/);
  for (const row of rows) assert.ok(visibleWidth(row) <= 30);
});
