import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatusLine } from "../../dist/cli/status-line.js";

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

test("status line right-aligns effort and keeps tokens in the middle", () => {
  const line = formatStatusLine("kilo/kilo-auto/free", "tokens: 12/34", "effort: medium", 80);
  assert.equal(visibleWidth(line), 80);
  assert.ok(line.startsWith("kilo/kilo-auto/free"));
  assert.ok(line.endsWith("effort: medium"));
  const tokensAt = line.indexOf("tokens: 12/34");
  assert.ok(tokensAt > 10 && tokensAt < 60, `tokens at ${tokensAt}`);
});

test("status line measures ANSI-styled parts by visible width", () => {
  const line = formatStatusLine(DIM("provider/model"), DIM("tokens: 1/2"), DIM("effort: high"), 60);
  assert.equal(visibleWidth(line), 60);
  assert.ok(line.endsWith(DIM("effort: high")));
});

test("status line truncates instead of overflowing a narrow terminal", () => {
  const line = formatStatusLine("a-long-provider/model-name", "tokens: 999/999", "effort: medium", 20);
  assert.ok(visibleWidth(line) <= 20, `width ${visibleWidth(line)}`);
  assert.ok(line.includes("…"));
});
