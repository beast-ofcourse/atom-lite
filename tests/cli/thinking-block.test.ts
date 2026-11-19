import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { darkTheme } from "../../dist/cli/theme.js";
import { ThinkingBlock } from "../../dist/cli/thinking-block.js";

const sep = darkTheme.tokens.dim("│ ");
const header = darkTheme.tokens.dim("💭 thinking");

function expected(text: string, width: number): string[] {
  return [
    header,
    ...wrapTextWithAnsi(text, Math.max(1, width - 2)).map(
      (line) => sep + darkTheme.tokens.dim(line),
    ),
  ];
}

function feed(block: ThinkingBlock, chunks: string[]): void {
  for (const chunk of chunks) block.append(chunk);
}

const chunks = [
  "First short line\n",
  "A much longer line of thinking text that has to wrap ",
  "across the terminal width and then continues here\n",
  "third line\n",
  "partial tail",
];

test("thinking block matches a full re-wrap across incremental deltas", () => {
  const block = new ThinkingBlock(darkTheme);
  feed(block, chunks);
  assert.deepEqual(block.render(40), expected(chunks.join(""), 40));
});

test("thinking block seals complete lines when a delta spans several", () => {
  const block = new ThinkingBlock(darkTheme);
  block.append("one\ntwo\nthree");
  assert.deepEqual(block.render(40), expected("one\ntwo\nthree", 40));
  block.append("\nfour\n");
  assert.deepEqual(block.render(40), expected("one\ntwo\nthree\nfour\n", 40));
});

test("thinking block re-wraps on width and theme changes", () => {
  const block = new ThinkingBlock(darkTheme);
  feed(block, chunks);
  assert.deepEqual(block.render(40), expected(chunks.join(""), 40));
  assert.deepEqual(block.render(80), expected(chunks.join(""), 80));

  const plain = {
    ...darkTheme,
    tokens: Object.fromEntries(
      Object.keys(darkTheme.tokens).map((key) => [key, (t: string) => t]),
    ),
  } as typeof darkTheme;
  block.setTheme(plain);
  const lines = block.render(80).join("\n");
  assert.ok(lines.includes("First short line"));
  assert.ok(!lines.includes("\x1b["));
});

test("thinking block stays cheap as the sealed buffer grows", () => {
  const block = new ThinkingBlock(darkTheme);
  const line = "reasoning line with enough words to wrap across the pane\n";
  for (let i = 0; i < 4000; i++) block.append(line);
  block.render(120);

  const started = performance.now();
  for (let i = 0; i < 50; i++) {
    block.append("more thinking ");
    block.render(120);
  }
  const perFrame = (performance.now() - started) / 50;
  assert.ok(perFrame < 4, `per-frame cost grew to ${perFrame.toFixed(2)}ms`);
});
