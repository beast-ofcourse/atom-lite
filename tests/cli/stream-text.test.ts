import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "../../dist/cli/transcript.js";
import { Text } from "@earendil-works/pi-tui";
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

test("stream text renders back-to-back deltas without a full transcript invalidation", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);
  stream.append("first");
  stream.append("second");
  assert.match(transcript.container.render(80).join("\n"), /firstsecond/);
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

test("stream text seals completed blocks before continuing", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);
  stream.append("first block\n\n");
  stream.append("second block tail");
  const rendered = transcript.container.children
    .map((child) => child.render(80).join("\n"))
    .join("\n");
  assert.match(rendered, /first block/);
  assert.match(rendered, /second block tail/);
  assert.ok(transcript.container.children.length >= 2);
});

test("stream text never seals a fenced code block mid-block", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 40, 40);
  stream.append("```js\n");
  for (let i = 0; i < 100; i++) stream.append(`code line ${i}\n`);
  assert.equal(transcript.container.children.length, 1);
  stream.append("```\n\nafter fence");
  const rendered = transcript.container.children
    .map((child) => child.render(80).join("\n"))
    .join("\n");
  assert.match(rendered, /code line 99/);
  assert.match(rendered, /after fence/);
});

test("stream text moves the live block after existing transcript entries", () => {
  const transcript = new Transcript();
  transcript.add(new Text("header"));
  const stream = new StreamText(transcript);
  // A user box / thinking block is added after StreamText was constructed.
  transcript.add(new Text("user input"));
  stream.append("assistant answer");
  const rendered = transcript.container.render(80).join("\n");
  assert.ok(
    rendered.indexOf("user input") < rendered.indexOf("assistant answer"),
    rendered,
  );
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

test("stream text reflects a later append in the next render", () => {
  const transcript = new Transcript();
  const stream = new StreamText(transcript, 200, 200);

  stream.append("alpha");
  assert.match(transcript.container.render(80).join("\n"), /alpha/);
  stream.append("beta");

  assert.match(transcript.container.render(80).join("\n"), /beta/);
});
