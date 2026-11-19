// Contract: instruction state is a frozen baseline plus hash-identified
// updates; compaction folds current text into a new baseline, and replay can
// rewind updates without touching the baseline.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldInstructionBaseline,
  hashInstructions,
  initialBaseline,
  recordInstructionChange,
  renderedInstructionTexts,
  rewindInstructionBaseline,
} from "../../dist/context/instruction-baseline.js";

test("initial baseline renders its frozen text", () => {
  const state = initialBaseline(["rule one", "rule two"], 0);
  assert.deepEqual(renderedInstructionTexts(state), ["rule one", "rule two"]);
  assert.equal(state.baselineSeq, 0);
});

test("a changed instruction set appends one hash-identified update", () => {
  const initial = initialBaseline(["rule one"], 0);
  const changed = recordInstructionChange(
    initial,
    ["rule one", "rule two"],
    7,
  );
  assert.equal(changed.updates.length, 1);
  assert.equal(changed.updates[0].seq, 7);
  assert.equal(changed.updates[0].hash, hashInstructions(["rule one", "rule two"]));
  assert.deepEqual(renderedInstructionTexts(changed), [
    "rule one",
    "rule two",
  ]);
  const same = recordInstructionChange(
    changed,
    ["rule one", "rule two"],
    8,
  );
  assert.equal(same, changed);
});

test("a fold freezes current text and drops earlier updates", () => {
  const changed = recordInstructionChange(
    initialBaseline(["old"]),
    ["new"],
    4,
  );
  const folded = foldInstructionBaseline(changed, ["new"], 9);
  assert.deepEqual(folded.baseline, ["new"]);
  assert.equal(folded.baselineSeq, 9);
  assert.deepEqual(folded.updates, []);
  assert.deepEqual(renderedInstructionTexts(folded), ["new"]);
});

test("rewind drops updates at or after a sequence", () => {
  let state = initialBaseline(["base"]);
  state = recordInstructionChange(state, ["one"], 3);
  state = recordInstructionChange(state, ["two"], 6);
  const rewound = rewindInstructionBaseline(state, 6);
  assert.equal(rewound.updates.length, 1);
  assert.equal(rewound.updates[0].seq, 3);
  assert.deepEqual(renderedInstructionTexts(rewound), ["base", "one"]);
});

test("repeated text across updates is not rendered twice", () => {
  let state = initialBaseline(["base"]);
  state = recordInstructionChange(state, ["base", "new"], 2);
  state = recordInstructionChange(state, ["base", "new", "later"], 5);
  assert.deepEqual(renderedInstructionTexts(state), [
    "base",
    "new",
    "later",
  ]);
});
