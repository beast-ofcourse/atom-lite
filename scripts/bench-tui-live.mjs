import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  Editor,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { Activity } from "../dist/cli/activity.js";
import { StatusLine } from "../dist/cli/status-line.js";
import {
  STREAM_LIVE_LINES,
  STREAM_SEAL_BATCH,
  StreamText,
} from "../dist/cli/stream-text.js";
import { ThinkingBlock } from "../dist/cli/thinking-block.js";
import { Transcript } from "../dist/cli/transcript.js";

execSync("npm run build", { stdio: "ignore" });

const rows = 36;
const columns = 120;
const deltas = Number(process.env.BENCH_TUI_LIVE_DELTAS ?? 180);
const writes = [];
const terminal = {
  columns,
  rows,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  restoreOnExit() {},
  async drainInput() {},
  write(data) {
    writes.push({ at: performance.now(), bytes: Buffer.byteLength(data) });
  },
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
  setProgramStatus() {},
};

const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
const renderDurations = [];
const renderChildCounts = [];
const originalRender = tui.doRender.bind(tui);
tui.doRender = () => {
  const started = performance.now();
  originalRender();
  renderDurations.push(performance.now() - started);
  renderChildCounts.push(transcript.container.children.length);
};
const transcript = new Transcript();
for (let i = 0; i < 400; i++) {
  transcript.add(new Text(`sealed context line ${i} `.repeat(4)));
}
const output = new ScrollView(transcript.container, {
  follow: "end",
  primary: true,
});
const status = new StatusLine();
let statusUpdates = 0;
const activity = new Activity({
  onChange: () => {
    statusUpdates++;
    const text = activity.text();
    status.setParts({
      left: "bench/model",
      tokens: "tokens: 9k/256k",
      effort: "effort: medium",
      mode: "yolo",
      activity: text,
    });
  },
});
const input = new Editor(tui, {
  borderColor: (value) => value,
  selectList: {
    selectedPrefix: (value) => value,
    selectedText: (value) => value,
    description: (value) => value,
    scrollInfo: (value) => value,
    noMatch: (value) => value,
  },
});
const root = new VStack([]);
root.addChild(output, { grow: 1, shrink: 1, minSize: 0 });
root.addChild(new Spacer(1), { grow: 0, shrink: 0, minSize: 1 });
root.addChild(input, { grow: 0, shrink: 0 });
root.addChild(status, { grow: 0, shrink: 0 });
tui.setLayoutRoot(root);
tui.setFocus(input);
tui.start();

const thinking = new ThinkingBlock();
transcript.add(thinking);
const stream = new StreamText(
  transcript,
  STREAM_LIVE_LINES,
  STREAM_SEAL_BATCH,
);
activity.start("thinking");

const start = performance.now();
for (let i = 0; i < deltas; i++) {
  const phase = i / deltas;
  if (phase < 0.4) {
    thinking.append(`reasoning fragment ${i} `);
    activity.setPhase("thinking");
  } else if (phase < 0.5) {
    activity.setPhase("working", "write");
  } else if (phase < 0.55) {
    activity.setPhase("working", "bash");
  } else {
    stream.append(
      `answer line ${i}${i % 8 === 7 ? "\n" : " "}`,
    );
    activity.setPhase("working");
  }
  status.setParts({
    left: "bench/model",
    tokens: `tokens: ${9 + i / 100}/256k`,
    effort: "effort: medium",
    mode: "yolo",
    activity: activity.text(),
  });
  tui.requestRender();
  await new Promise((resolve) => setTimeout(resolve, 16));
}
const elapsed = performance.now() - start;
activity.stop();
await new Promise((resolve) => setTimeout(resolve, 60));
const frameGaps = [];
for (let i = 1; i < writes.length; i++) {
  frameGaps.push(writes[i].at - writes[i - 1].at);
}
frameGaps.sort((a, b) => a - b);
const pick = (p) =>
  Number(frameGaps[Math.floor((frameGaps.length - 1) * p)].toFixed(2));

const frame = renderLayoutFrame(root, columns, rows, () => {});
const screen = frame.lines
  .map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
  .join("\n");
writeFileSync("/tmp/opencode/tui-live-screen.txt", screen + "\n");

const report = {
  sourceCommit: `${execSync("git rev-parse --short HEAD").toString().trim()}${execSync("git diff --quiet || echo dirty").toString().trim() === "dirty" ? "-dirty" : ""}`,
  deltas,
  elapsedMs: Number(elapsed.toFixed(2)),
  frames: writes.length,
  framesOver16Ms: frameGaps.filter((gap) => gap > 16.5).length,
  gapP50Ms: pick(0.5),
  gapP95Ms: pick(0.95),
  gapMaxMs: Number(Math.max(...frameGaps).toFixed(2)),
  renderP50Ms: Number(
    [...renderDurations].sort((a, b) => a - b)[
      Math.floor((renderDurations.length - 1) * 0.5)
    ].toFixed(2),
  ),
  renderP95Ms: Number(
    [...renderDurations].sort((a, b) => a - b)[
      Math.floor((renderDurations.length - 1) * 0.95)
    ].toFixed(2),
  ),
  renderMaxMs: Number(Math.max(...renderDurations).toFixed(2)),
  rendersOver16Ms: renderDurations.filter((value) => value > 16).length,
  slowestRenders: renderDurations
    .map((duration, index) => ({
      duration: Number(duration.toFixed(2)),
      index,
      children: renderChildCounts[index],
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5),
  bytesPerFrameP95: Number(
    [...writes].map((w) => w.bytes).sort((a, b) => a - b)[
      Math.floor((writes.length - 1) * 0.95)
    ],
  ),
  statusUpdates,
  children: transcript.container.children.length,
};
writeFileSync("/tmp/opencode/tui-live.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
tui.stop();
process.exit(0);
