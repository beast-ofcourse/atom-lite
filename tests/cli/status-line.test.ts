import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StatusLine } from "../../dist/cli/status-line.js";

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

function render(parts: { left: string; tokens: string; effort: string }, width: number) {
  const status = new StatusLine();
  status.setParts(parts);
  return status.render(width);
}

test("status line puts tokens below provider/model and keeps effort on top", () => {
  const rows = render(
    {
      left: "kilo/kilo-auto/free",
      tokens: "tokens: 4.5k/256k",
      effort: "effort: medium",
    },
    80,
  );
  assert.equal(rows.length, 2);
  assert.equal(visibleWidth(rows[0]), 80);
  assert.equal(visibleWidth(rows[1]), 80);
  assert.ok(rows[0].trimStart().startsWith("kilo/kilo-auto/free"));
  assert.ok(rows[0].trimEnd().endsWith("effort: medium"));
  assert.ok(rows[1].trimStart().startsWith("tokens: 4.5k/256k"));
});

test("status line measures ANSI-styled parts by visible width", () => {
  const rows = render(
    {
      left: DIM("provider/model"),
      tokens: DIM("tokens: 1.2k/1M"),
      effort: DIM("effort: high"),
    },
    60,
  );
  assert.equal(rows.length, 2);
  assert.equal(visibleWidth(rows[0]), 60);
  assert.equal(visibleWidth(rows[1]), 60);
  assert.ok(rows[0].trimEnd().endsWith(DIM("effort: high")));
  assert.ok(rows[1].trimStart().startsWith(DIM("tokens: 1.2k/1M")));
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
  assert.ok(rows[0].includes("…"));
});
