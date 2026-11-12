import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  ansiTheme,
  darkTheme,
  detectColorScheme,
  isNoColorEnabled,
  lightTheme,
  resolveTheme,
  resolveThemeName,
  themeNames,
} from "../../dist/cli/theme.js";
import { Banner } from "../../dist/cli/banner.js";

test("theme registry exposes the built-in names", () => {
  assert.deepEqual(themeNames(), [
    "auto",
    "dark",
    "light",
    "ansi",
    "dracula",
    "monokai",
    "nord",
    "solarized",
  ]);
});

test("semantic tokens render text and differ between dark and light", () => {
  for (const theme of [darkTheme, lightTheme]) {
    assert.equal(stripTerminalSequences(theme.tokens.accent("hello")), "hello");
  }
  assert.notEqual(darkTheme.tokens.accent("x"), lightTheme.tokens.accent("x"));
});

test("resolveTheme maps built-ins and defaults unknown names to dark", () => {
  assert.equal(resolveTheme("dark", { env: {} }).name, "dark");
  assert.equal(resolveTheme("light", { env: {} }).name, "light");
  assert.equal(resolveTheme("ansi", { env: {} }).name, "ansi");
  assert.equal(resolveTheme("does-not-exist", { env: {} }).name, "dark");
});

test("NO_COLOR and --no-color force the no-colour theme", () => {
  assert.equal(isNoColorEnabled({ NO_COLOR: "1" }), true);
  assert.equal(isNoColorEnabled({ NO_COLOR: "" }), false);
  assert.equal(resolveTheme("dark", { env: { NO_COLOR: "1" } }).name, "ansi");
  assert.equal(resolveTheme("light", { noColor: true }).name, "ansi");
  assert.equal(resolveThemeName("dark", { noColor: true }), "ansi");
});

test("auto detects the background from COLORFGBG then defaults to dark", () => {
  assert.equal(detectColorScheme({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectColorScheme({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectColorScheme({ COLORFGBG: "0;7" }), "light");
  assert.equal(detectColorScheme({ COLORFGBG: "bogus" }), undefined);
  assert.equal(detectColorScheme({}), undefined);

  assert.equal(resolveTheme("auto", { env: {} }).name, "dark");
  assert.equal(
    resolveTheme("auto", { env: { COLORFGBG: "0;15" } }).name,
    "light",
  );
  assert.equal(
    resolveTheme("auto", { env: { COLORFGBG: "15;0" }, scheme: "light" }).name,
    "light",
  );
});

test("no-colour tokens and banner emit no escape sequences", () => {
  assert.equal(ansiTheme.tokens.banner("atom"), "atom");
  const rows = new Banner(ansiTheme).render(80);
  for (const row of rows) {
    assert.equal(stripTerminalSequences(row), row);
  }
});
