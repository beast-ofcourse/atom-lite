import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "../../dist/cli/transcript.js";
import { StreamText } from "../../dist/cli/stream-text.js";

// Longer than one 16ms display frame, shorter than the old 50ms throttle,
// so this would fail against the old behaviour.
const FRAME_WAIT_MS = 30;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("stream text seals completed lines in batches", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 2, 2);
  for (let i = 0; i < 100; i++) {
    stream.append(`line ${i}\n`);
  }
  stream.append("tail");

  // 100 lines with a live tail of at most 4 lines and batches of ~3 lines.
  assert.ok(
    transcript.container.children.length < 40,
    `components: ${transcript.container.children.length}`,
  );
  const last =
    transcript.container.children[transcript.container.children.length - 1];
  assert.match(last.render(80).join("\n"), /tail/);
});

test("stream text finalizes without dropping rendered output", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 2, 2);
  stream.append("first message");
  stream.finalize();
  stream.append("second message");
  const rendered = transcript.container.children
    .map((c) => c.render(80).join("\n"))
    .join("\n");
  assert.match(rendered, /first message/);
  assert.match(rendered, /second message/);
});

test("stream text renders markdown headings", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);
  stream.append("# Title\n\nbody");
  stream.finalize();
  const rendered = transcript.container.children
    .map((c) => c.render(80).join("\n"))
    .join("\n");
  assert.match(rendered, /Title/);
  assert.match(rendered, /body/);
});

test("stream text paints the first append immediately", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);
  stream.append("first paint text");
  const rendered = transcript.container.render(80).join("\n");
  assert.match(rendered, /first paint text/);
});

test("stream text reflects a later append after one frame when appends arrive faster than the interval", async () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);

  stream.append("alpha");
  assert.match(transcript.container.render(80).join("\n"), /alpha/);

  // Several appends inside a single frame; the live buffer updates but the
  // container's cached lines do not until the next invalidate.
  stream.append("beta");
  stream.append("gamma-fast");
  transcript.container.render(80);

  await wait(FRAME_WAIT_MS);
  stream.append("delta");

  const rendered = transcript.container.render(80).join("\n");
  assert.match(rendered, /alpha/);
  assert.match(rendered, /delta/);
});
