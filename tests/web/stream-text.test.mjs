import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPacedText,
  STREAM_FRAME_MS,
  STREAM_CHARS_PER_FRAME,
  STREAM_FINAL_MULTIPLIER,
} from "../../web/stream-text.js";

function waitFor(condition, { timeout = 1000, interval = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error("timed out waiting for condition"));
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

test("exports the tuned pacing constants", () => {
  assert.equal(STREAM_FRAME_MS, 16);
  assert.equal(STREAM_CHARS_PER_FRAME, 512);
  assert.equal(STREAM_FINAL_MULTIPLIER, 4);
});

test("the first push paints synchronously before any timer", () => {
  const updates = [];
  const stream = createPacedText({ onUpdate: (text) => updates.push(text) });

  stream.push("hello");

  assert.deepEqual(updates, ["hello"]);
  stream.cancel();
});

test("a burst larger than one frame budget drains over frames to full text", async () => {
  const payload = "x".repeat(STREAM_CHARS_PER_FRAME * 2 + 10);
  const updates = [];
  const stream = createPacedText({ onUpdate: (text) => updates.push(text) });

  stream.push(payload);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].length, STREAM_CHARS_PER_FRAME);

  await waitFor(() => updates.at(-1) === payload);
  assert.equal(updates.at(-1), payload);
  stream.cancel();
});

test("finalize delivers the complete raw text", async () => {
  let finalized;
  const stream = createPacedText({
    onFinalize: (text) => {
      finalized = text;
    },
  });

  stream.push("hello ");
  stream.push("world");
  stream.finalize();

  await waitFor(() => finalized !== undefined);
  assert.equal(finalized, "hello world");
});

test("cancel stops further updates and finalization", async () => {
  const payload = "x".repeat(STREAM_CHARS_PER_FRAME * 3);
  let updateCount = 0;
  let finalized = false;
  const stream = createPacedText({
    onUpdate: () => {
      updateCount += 1;
    },
    onFinalize: () => {
      finalized = true;
    },
  });

  stream.push(payload);
  assert.equal(updateCount, 1);

  stream.cancel();
  await new Promise((resolve) => setTimeout(resolve, STREAM_FRAME_MS * 3));

  assert.equal(updateCount, 1);
  assert.equal(finalized, false);
});
