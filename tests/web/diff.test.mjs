import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffModel,
  changedSegments,
  pairChangedLines,
} from "../../web/diff.js";

test("a runtime diff becomes render-ready rows with stats and path", () => {
  const model = buildDiffModel([
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "-const old = 2;",
    "+const fresh = 2;",
    " export default 1;",
  ]);
  assert.equal(model.path, "src/app.ts");
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  assert.equal(model.truncated, false);
  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["del", "add", "context"],
  );
});

test("word changes are paired across adjacent remove/add runs", () => {
  const model = buildDiffModel(["-const old = 2;", "+const fresh = 2;"]);
  assert.equal(model.rows[0].segments[0].text, "const ");
  assert.equal(model.rows[0].segments[1].text, "old");
  assert.equal(model.rows[0].segments[1].changed, true);
  assert.equal(model.rows[1].segments[1].text, "fresh");
  assert.equal(model.rows[1].segments[1].changed, true);
});

test("hunk headers carry line numbers and truncation is bounded", () => {
  const lines = [
    "@@ -10,2 +10,2 @@",
    "-old",
    "+new",
    ...Array.from({ length: 20 }, (_, index) => ` context ${index}`),
  ];
  const model = buildDiffModel(lines, { maxLines: 4 });
  assert.equal(model.rows[0].kind, "hunk");
  assert.equal(model.rows[1].oldLine, 10);
  assert.equal(model.rows[2].newLine, 10);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 23);
});

test("a changed suffix highlights only the differing tail", () => {
  assert.deepEqual(changedSegments("hello world", "hello there"), {
    before: [
      { text: "hello ", changed: false },
      { text: "world", changed: true },
    ],
    after: [
      { text: "hello ", changed: false },
      { text: "there", changed: true },
    ],
  });
});

test("unpaired runs stay whole-line and never throw", () => {
  const rows = [
    { kind: "del", text: "one" },
    { kind: "del", text: "two" },
    { kind: "add", text: "three" },
  ];
  assert.doesNotThrow(() => pairChangedLines(rows));
  assert.equal(rows[0].segments[0].changed, true);
  assert.equal(rows[1].segments, undefined);
  assert.equal(rows[2].segments[0].changed, true);
});
