import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "../../dist/cli/transcript.js";
import { StreamText } from "../../dist/cli/stream-text.js";

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
