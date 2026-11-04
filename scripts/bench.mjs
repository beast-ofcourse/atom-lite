#!/usr/bin/env node
/**
 * Non-gating performance report. Budgets are printed for visibility; the
 * process always exits 0 so CI does not flake on shared hardware.
 *
 * Run: npm run bench   (BENCH_RUNS=25 for more samples)
 */
import { performance } from "node:perf_hooks";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Container, Text } from "@earendil-works/pi-tui";
import { readTool, writeTool, editTool, bashTool } from "../dist/tools/index.js";
import { defaultShell } from "../dist/security/process.js";
import { Transcript } from "../dist/cli/transcript.js";
import { StreamText } from "../dist/cli/stream-text.js";

const RUNS = Math.max(3, Number(process.env.BENCH_RUNS ?? 15));
const ROOT = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "atom-bench-"));
const signal = new AbortController().signal;
const ctx = { workspace: dir, signal, maxBashTimeMs: 10_000, maxToolOutputBytes: 30_000 };

const results = [];
function record(name, value, unit, budget) {
  results.push({ name, value, unit, budget });
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
async function bench(fn, runs = RUNS) {
  for (let i = 0; i < Math.min(3, runs); i++) await fn(i);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn(i);
    samples.push(performance.now() - t);
  }
  return median(samples);
}

// 1 MiB of ~100-byte lines.
const line = "x".repeat(96) + "\n";
const big = line.repeat(Math.ceil((1024 * 1024) / line.length));
const bigPath = join(dir, "big.txt");
writeFileSync(bigPath, big);
const bigEdit = big.slice(0, 4096) + "NEEDLE" + big.slice(4096 + 6);
const editSource = join(dir, "edit-source.txt");
writeFileSync(editSource, bigEdit);

console.log(`atom-lite bench (${RUNS} runs, ${(big.length / 1024).toFixed(0)} KiB file)\n`);

// --- tool overhead ---------------------------------------------------------
const rawRead = await bench(() => readFileSync(bigPath));
const fullRead = await bench(() =>
  readTool.execute({ id: "r", name: "read", arguments: { path: "big.txt" } }, ctx),
);
record("read full (tool)", fullRead, "ms", null);
record("read full overhead vs readFileSync", fullRead - rawRead, "ms", 5);

const partialRead = await bench(() =>
  readTool.execute(
    { id: "r", name: "read", arguments: { path: "big.txt", offset: 5000, limit: 50 } },
    ctx,
  ),
);
record("read 50 lines (tool)", partialRead, "ms", null);
record("read partial overhead vs readFileSync", partialRead - rawRead, "ms", 5);

const newContent = big;
const rawWrite = await bench((i) => {
  const p = join(dir, `raw-${i}.txt`);
  const tmp = p + ".tmp";
  writeFileSync(tmp, newContent);
  renameSync(tmp, p);
});
const toolWrite = await bench((i) =>
  writeTool.execute(
    { id: "w", name: "write", arguments: { path: `tool-${i}.txt`, content: newContent } },
    ctx,
  ),
);
record("write 1 MiB (tool)", toolWrite, "ms", null);
record("write overhead vs rename", toolWrite - rawWrite, "ms", 5);

const rawEdit = await bench((i) => {
  const p = join(dir, `raw-edit-${i}.txt`);
  copyFileSync(editSource, p);
  const text = readFileSync(p, "utf8").replace("NEEDLE", "CHANGED");
  const tmp = p + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, p);
});
const toolEdit = await bench((i) => {
  const p = `tool-edit-${i}.txt`;
  copyFileSync(editSource, join(dir, p));
  return editTool.execute(
    {
      id: "e",
      name: "edit",
      arguments: { path: p, old_string: "NEEDLE", new_string: "CHANGED" },
    },
    ctx,
  );
});
record("edit 1 MiB (tool)", toolEdit, "ms", null);
record("edit overhead vs read/replace/rename", toolEdit - rawEdit, "ms", 5);

const rawBash = await bench(
  () =>
    new Promise((resolve) => {
      const child = spawn(defaultShell(), ["-c", "true"], { cwd: dir, env: process.env });
      child.on("close", resolve);
    }),
);
const toolBash = await bench(() =>
  bashTool.execute({ id: "b", name: "bash", arguments: { command: "true" } }, ctx),
);
record("bash (tool)", toolBash, "ms", null);
record("bash overhead vs raw shell", toolBash - rawBash, "ms", 10);

// --- startup ---------------------------------------------------------------
const startup = await bench(
  () => {
    const r = spawnSync(process.execPath, [join(ROOT, "dist/cli/main.js"), "--version"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(r.stderr);
  },
  Math.min(RUNS, 7),
);
record("startup (--version)", startup, "ms", 300);

// --- frame build -----------------------------------------------------------
const oneK = new Container();
for (let i = 0; i < 1000; i++) oneK.addChild(new Text(`line ${i}`));
const firstFrame = await bench(() => oneK.render(120), 1);
const warmFrame = await bench(() => oneK.render(120), 20);
record("frame build, 1k components (first)", firstFrame, "ms", 16);
record("frame build, 1k components (cached)", warmFrame, "ms", 16);

const transcript = new Transcript();
const stream = new StreamText(transcript);
let maxAppend = 0;
const textLines = 10_000;
for (let i = 0; i < textLines; i++) {
  const t = performance.now();
  stream.append(`streamed line ${i} padding\n`);
  maxAppend = Math.max(maxAppend, performance.now() - t);
}
const streamFrame = await bench(() => transcript.container.render(120), 10);
record("stream append max, 10k lines", maxAppend, "ms", 16);
record("frame build, 10k streamed lines", streamFrame, "ms", 16);

// --- report ----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
console.log(pad("metric", 42) + pad("value", 12) + "budget");
console.log("-".repeat(70));
for (const r of results) {
  const over = r.budget !== null && r.value > r.budget ? "  OVER" : "";
  console.log(
    pad(r.name, 42) +
      pad(`${num(r.value)} ${r.unit}`, 12) +
      (r.budget !== null ? `<= ${r.budget} ${r.unit}${over}` : "-"),
  );
}
console.log(
  `\nnon-gating: ${results.filter((r) => r.budget !== null && r.value > r.budget).length} over budget`,
);

rmSync(dir, { recursive: true, force: true });
process.exit(0);
