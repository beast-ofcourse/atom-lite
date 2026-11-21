import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Editor, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { Transcript } from "../dist/cli/transcript.js";

execSync("npm run build", { stdio: "ignore" });

const width = 120;
const height = 36;
const seeded = Number(process.env.BENCH_TUI_KEY_SEEDED ?? 900);
const keys = Number(process.env.BENCH_TUI_KEY_DELTAS ?? 240);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * p)].toFixed(3));
}

function makeRoot(transcript) {
  const scroller = new ScrollView(transcript.container, { follow: "end" });
  const root = new VStack([]);
  root.addChild(scroller, { grow: 1, shrink: 1, minSize: 0 });
  root.addChild(new Text("input"), { grow: 0, shrink: 0 });
  return root;
}

function run(seedCount) {
  const transcript = new Transcript();
  for (let i = 0; i < seedCount; i++) {
    transcript.add(new Text(`sealed context line ${i} `.repeat(4)));
  }
  const root = makeRoot(transcript);
  const editor = new Editor(null, {
    borderColor: (value) => value,
    selectList: {
      selectedPrefix: (value) => value,
      selectedText: (value) => value,
      description: (value) => value,
      scrollInfo: (value) => value,
      noMatch: (value) => value,
    },
  });
  renderLayoutFrame(root, width, height, () => {});
  const inputSamples = [];
  const frameSamples = [];
  for (let i = 0; i < keys; i++) {
    const start = performance.now();
    editor.handleInput(String.fromCharCode(97 + (i % 26)));
    inputSamples.push(performance.now() - start);
    const frameStart = performance.now();
    renderLayoutFrame(root, width, height, () => {});
    frameSamples.push(performance.now() - frameStart);
  }
  return {
    input: {
      p50Ms: percentile(inputSamples, 0.5),
      p95Ms: percentile(inputSamples, 0.95),
      maxMs: Number(Math.max(...inputSamples).toFixed(3)),
    },
    frame: {
      p50Ms: percentile(frameSamples, 0.5),
      p95Ms: percentile(frameSamples, 0.95),
      maxMs: Number(Math.max(...frameSamples).toFixed(3)),
    },
    children: transcript.container.children.length,
  };
}

const report = {
  sourceCommit: execSync("git rev-parse --short HEAD").toString().trim(),
  seeded,
  keys,
  width,
  height,
  largeTranscript: run(seeded),
  emptyTranscript: run(0),
};
console.log(JSON.stringify(report, null, 2));
