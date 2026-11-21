// True side-by-side benchmark: Atom-lite's pi-tui (1.5) vs the Pi agent's
// current tui package (1.6, built from /home/bhavin/temp/pi/packages/tui).
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * p)].toFixed(3));
}

function stats(samples) {
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
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
  const h = makeHarness(lib, layout, 400, true);
  const editor = h.root.children[1];
  const samples = [];
  for (let i = 0; i < 240; i++) {
    editor.handleInput(String.fromCharCode(97 + (i % 26)));
    const start = performance.now();
    h.render();
    if (i >= 8) samples.push(performance.now() - start);
  }
  return { ...stats(samples), children: h.transcript.children.length };
}

const report = {
  width: WIDTH,
  height: HEIGHT,
  deltas: DELTAS,
  atom: {
    version: "pi-tui 1.5 (installed)",
    stream: runStream(ours, { renderLayoutFrame: ourLayout }),
    scroll: runScroll(ours, { renderLayoutFrame: ourLayout }),
    keys: runKeys(ours, { renderLayoutFrame: ourLayout }),
  },
  pi: {
    version: "pi-tui 1.6 (built from /home/bhavin/temp/pi)",
    stream: runStream(pi, piLayout),
    scroll: runScroll(pi, piLayout),
    keys: runKeys(pi, piLayout),
  },
};
console.log(JSON.stringify(report, null, 2));
