import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { StreamText } from "../dist/cli/stream-text.js";
import { Transcript } from "../dist/cli/transcript.js";

execSync("npm run build", { stdio: "ignore" });

const width = 120;
const height = 36;
const deltas = Number(process.env.BENCH_TUI_COMPARE_DELTAS ?? 160);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * p)].toFixed(3));
}

function rootFor(container) {
  const scroller = new ScrollView(container, { follow: "end" });
  const root = new VStack([]);
  root.addChild(scroller, { grow: 1, shrink: 1, minSize: 0 });
  root.addChild(new Text("input"), { grow: 0, shrink: 0 });
  return root;
}

/** Naive transcript: one component per line, no sealing, no pruning. */
function naive() {
  const container = new Container();
  const root = rootFor(container);
  renderLayoutFrame(root, width, height, () => {});
  const samples = [];
  let buffer = "";
  for (let i = 0; i < deltas; i++) {
    buffer += `answer line ${i}${i % 8 === 7 ? "\n" : " "}`;
    container.children[container.children.length - 1]?.invalidate?.();
    container.addChild(new Text(buffer.slice(-400)));
    const start = performance.now();
    renderLayoutFrame(root, width, height, () => {});
    samples.push(performance.now() - start);
  }
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    children: container.children.length,
  };
}

/** Atom-lite: sealed Markdown blocks, one small live tail, bounded children. */
function atom() {
  const transcript = new Transcript();
  const stream = new StreamText(transcript);
  const root = rootFor(transcript.container);
  renderLayoutFrame(root, width, height, () => {});
  const samples = [];
  for (let i = 0; i < deltas; i++) {
    stream.append(`answer line ${i}${i % 8 === 7 ? "\n" : " "}`);
    const start = performance.now();
    renderLayoutFrame(root, width, height, () => {});
    samples.push(performance.now() - start);
  }
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    children: transcript.container.children.length,
  };
}

const baseline = naive();
const optimized = atom();
const report = {
  sourceCommit: execSync("git rev-parse --short HEAD").toString().trim(),
  deltas,
  width,
  height,
  naiveTranscript: baseline,
  atomTranscript: optimized,
  p95Improvement: Number((baseline.p95Ms / optimized.p95Ms).toFixed(2)),
  maxImprovement: Number((baseline.maxMs / optimized.maxMs).toFixed(2)),
};
console.log(JSON.stringify(report, null, 2));
