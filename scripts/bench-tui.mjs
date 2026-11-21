import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import {
  STREAM_LIVE_LINES,
  STREAM_SEAL_BATCH,
  StreamText,
} from "../dist/cli/stream-text.js";
import { ThinkingBlock } from "../dist/cli/thinking-block.js";
import { Transcript } from "../dist/cli/transcript.js";

execSync("npm run build", { stdio: "ignore" });

const output = process.argv[2] ?? "scripts/bench-tui.results.json";
const width = 120;
const height = 36;
const seeded = Number(process.env.BENCH_TUI_SEEDED ?? 900);
const deltas = Number(process.env.BENCH_TUI_DELTAS ?? 120);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * p)].toFixed(3));
}

const transcript = new Transcript();
for (let i = 0; i < seeded; i++) {
  transcript.add(new Text(`sealed line ${i} `.repeat(3)));
}
const scroller = new ScrollView(transcript.container, { follow: "end" });
const root = new VStack([]);
root.addChild(scroller, { grow: 1, shrink: 1, minSize: 0 });
root.addChild(new Text("input"), { grow: 0, shrink: 0 });
const stream = new StreamText(
  transcript,
  STREAM_LIVE_LINES,
  STREAM_SEAL_BATCH,
);
const thinking = new ThinkingBlock();
transcript.add(thinking);

let cache;
const contentSamples = [];
const viewSamples = [];
for (let i = 0; i < deltas; i++) {
  if (i < deltas / 2) thinking.append(`reasoning token ${i} `);
  else stream.append(`answer token ${i}${i % 4 === 3 ? "\n\n" : " "}`);
  if (process.env.BENCH_TUI_LEGACY_INVALIDATE === "1") {
    transcript.invalidate?.();
  }

  let start = performance.now();
  const frame = renderLayoutFrame(root, width, height, () => {});
  contentSamples.push(performance.now() - start);

  start = performance.now();
  renderLayoutFrame(root, width, height, () => {}, cache ?? frame.renderCache);
  viewSamples.push(performance.now() - start);
  cache = frame.renderCache;
}

const report = {
  sourceCommit: `${execSync("git rev-parse --short HEAD").toString().trim()}${execSync("git diff --quiet || echo dirty").toString().trim() === "dirty" ? "-dirty" : ""}`,
  seeded,
  deltas,
  width,
  height,
  liveWindow: STREAM_LIVE_LINES,
  content: {
    p50Ms: percentile(contentSamples, 0.5),
    p95Ms: percentile(contentSamples, 0.95),
    maxMs: Number(Math.max(...contentSamples).toFixed(3)),
  },
  viewOnly: {
    p50Ms: percentile(viewSamples, 0.5),
    p95Ms: percentile(viewSamples, 0.95),
    maxMs: Number(Math.max(...viewSamples).toFixed(3)),
  },
  children: transcript.container.children.length,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
