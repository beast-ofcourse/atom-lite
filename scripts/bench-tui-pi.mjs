// True side-by-side benchmark: Atom-lite's pi-tui vs the Pi agent's built tui.
// Each workload runs several times per arm; medians are reported to damp GC/JIT noise.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import * as ours from "@earendil-works/pi-tui";
import { renderLayoutFrame as ourLayout } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";

const PI_ROOT = "/home/bhavin/temp/pi/packages/tui/dist";
const pi = await import(pathToFileURL(`${PI_ROOT}/index.js`).href);
const piLayout = await import(pathToFileURL(`${PI_ROOT}/layout.js`).href);

const WIDTH = 120;
const HEIGHT = 36;
const DELTAS = Number(process.env.BENCH_PI_DELTAS ?? 160);
const REPEATS = Number(process.env.BENCH_PI_REPEATS ?? 5);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function stats(samples) {
  return {
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function gc() {
  globalThis.gc?.();
}

function makeHarness(lib, layout, seedCount, withEditor) {
  const transcript = new lib.Container();
  for (let i = 0; i < seedCount; i++) {
    transcript.addChild(new lib.Text(`sealed context line ${i} `.repeat(4)));
  }
  const theme = {
    heading: (t) => t,
    link: (t) => t,
    linkUrl: (t) => t,
    code: (t) => t,
    codeBlock: (t) => t,
    codeBlockBorder: (t) => t,
    quote: (t) => t,
    quoteBorder: (t) => t,
    hr: (t) => t,
    listBullet: (t) => t,
    bold: (t) => t,
    italic: (t) => t,
    strikethrough: (t) => t,
    underline: (t) => t,
    codeBlockIndent: "  ",
  };
  const live = new lib.Markdown("warm line content 123\n", 0, 0, theme);
  live.render(WIDTH);
  live.setText("");
  transcript.addChild(live);
  const scroller = new lib.ScrollView(transcript, { follow: "end" });
  const root = new lib.VStack([]);
  root.addChild(scroller, { grow: 1, shrink: 1, minSize: 0 });
  if (withEditor) {
    const fakeTui = {
      terminal: { rows: HEIGHT, columns: WIDTH },
      requestRender() {},
      setFocus() {},
    };
    root.addChild(
      new lib.Editor(fakeTui, {
        borderColor: (v) => v,
        selectList: {
          selectedPrefix: (v) => v,
          selectedText: (v) => v,
          description: (v) => v,
          scrollInfo: (v) => v,
          noMatch: (v) => v,
        },
      }),
      { grow: 0, shrink: 0 },
    );
  } else {
    root.addChild(new lib.Text("input"), { grow: 0, shrink: 0 });
  }
  const render = () => layout.renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
  for (let i = 0; i < 8; i++) render();
  return { transcript, scroller, live, root, render };
}

function runStream(lib, layout) {
  gc();
  const h = makeHarness(lib, layout, 400, false);
  const samples = [];
  for (let i = 0; i < DELTAS; i++) {
    h.live.setText(`answer line ${i}${i % 8 === 7 ? "\n" : " "}`);
    const start = performance.now();
    h.render();
    if (i >= 8) samples.push(performance.now() - start);
  }
  return { ...stats(samples), children: h.transcript.children.length };
}

function runScroll(lib, layout) {
  gc();
  const h = makeHarness(lib, layout, 900, false);
  const samples = [];
  for (let i = 0; i < 200; i++) {
    h.scroller.scrollTo((i * 37) % 4000);
    const start = performance.now();
    h.render();
    if (i >= 8) samples.push(performance.now() - start);
  }
  return { ...stats(samples), children: h.transcript.children.length };
}

function runKeys(lib, layout) {
  gc();
  const h = makeHarness(lib, layout, 400, true);
  const editor = h.root.children[1];
  const samples = [];
  for (let i = 0; i < 400; i++) {
    editor.handleInput(String.fromCharCode(97 + (i % 26)));
    const start = performance.now();
    h.render();
    if (i >= 8) samples.push(performance.now() - start);
  }
  return { ...stats(samples), children: h.transcript.children.length };
}

const workloads = { stream: runStream, scroll: runScroll, keys: runKeys };
const arms = {
  atom: {
    lib: ours,
    layout: { renderLayoutFrame: ourLayout },
    version: `pi-tui ${JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-tui/package.json", import.meta.url), "utf8")).version}`,
  },
  pi: {
    lib: pi,
    layout: piLayout,
    version: `pi-tui ${JSON.parse(readFileSync("/home/bhavin/temp/pi/packages/tui/package.json", "utf8")).version} (built)`,
  },
};

const report = {
  width: WIDTH,
  height: HEIGHT,
  deltas: DELTAS,
  repeats: REPEATS,
  versions: { atom: arms.atom.version, pi: arms.pi.version },
};

for (const [name, run] of Object.entries(workloads)) {
  const samples = { atom: [], pi: [] };
  for (let r = 0; r < REPEATS; r++) {
    // Alternate order so neither arm is always first.
    const order = r % 2 === 0 ? ["atom", "pi"] : ["pi", "atom"];
    for (const arm of order)
      samples[arm].push(run(arms[arm].lib, arms[arm].layout));
  }
  const summarize = (arr) => ({
    p50Ms: Number(median(arr.map((s) => s.p50Ms)).toFixed(3)),
    p95Ms: Number(median(arr.map((s) => s.p95Ms)).toFixed(3)),
    maxMs: Number(median(arr.map((s) => s.maxMs)).toFixed(3)),
  });
  const atom = summarize(samples.atom);
  const pi = summarize(samples.pi);
  report[name] = {
    atom,
    pi,
    p95Speedup: Number((pi.p95Ms / atom.p95Ms).toFixed(2)),
    maxSpeedup: Number((pi.maxMs / atom.maxMs).toFixed(2)),
  };
}

console.log(JSON.stringify(report, null, 2));
