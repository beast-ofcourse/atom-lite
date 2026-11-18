// Contract tests for ticket 14 (observability).
//
// Seams under test:
//   - ExtensionAPI.span()/metric(): an extension records duration, outcome and
//     counters without leaking raw values or attribute payloads into doctor.
//   - ExtensionLoader.diagnostics()/doctorJson(): per-extension counts, error
//     count and last error; full records available in-process for assertions.
//   - A reload resets an extension's records and caps them at 1000.
//
// Each test names the failure it pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-observability-"));
}

function makeLoader(dir: string): ExtensionLoader {
  return new ExtensionLoader({
    userDir: dir,
    agentDir: join(dir, "agent"),
  });
}

test("span and metric records carry duration and outcome; doctor exposes counts only", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "observed.js"),
      [
        "export default async (pi) => {",
        "  await pi.span('fetch', async () => { await new Promise(r => setTimeout(r, 1)); return 7; });",
        "  pi.metric('tokens', 42, { secret: 'do-not-leak' });",
        "  try { await pi.span('broken', () => { throw new Error('span boom'); }); } catch {}",
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    const records = loader.observability("observed");
    assert.equal(records.spans.length, 2, "both spans recorded");
    const ok = records.spans.find((span) => span.name === "fetch")!;
    assert.equal(ok.outcome, "ok");
    assert.ok(ok.durationMs >= 0, "duration recorded");
    assert.equal(ok.value, 7, "span returns the wrapped value");
    const bad = records.spans.find((span) => span.name === "broken")!;
    assert.equal(bad.outcome, "error");
    assert.match(bad.error ?? "", /span boom/);
    assert.equal(records.metrics.length, 1);
    assert.equal(records.metrics[0].value, 42);
    assert.deepEqual(records.metrics[0].attrs, { secret: "do-not-leak" });

    const [entry] = JSON.parse(loader.doctorJson());
    assert.equal(entry.observability.spanCount, 2);
    assert.equal(entry.observability.metricCount, 1);
    assert.equal(entry.observability.errorCount, 1);
    assert.match(entry.observability.lastError ?? "", /span boom/);
    const doctor = loader.doctorJson();
    assert.ok(!doctor.includes("do-not-leak"), "attribute payload leaked");
    assert.ok(!doctor.includes('"value"'), "raw metric value leaked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observability records are bounded at 1000 and reset on reload", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "busy.js"),
      [
        "export default (pi) => {",
        "  for (let i = 0; i < 1201; i++) {",
        "    pi.metric('count', i);",
        "    pi.span('work', () => i);",
        "  }",
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const records = loader.observability("busy");
    assert.equal(records.spans.length, 1000, "span buffer bounded");
    assert.equal(records.metrics.length, 1000, "metric buffer bounded");
    assert.equal(records.metrics[0].value, 201, "oldest records dropped");

    writeFileSync(join(dir, "busy.js"), "export default () => {};\n");
    await loader.loadAll();
    const reset = loader.observability("busy");
    assert.equal(reset.spans.length, 0, "spans reset on reload");
    assert.equal(reset.metrics.length, 0, "metrics reset on reload");
    const [entry] = JSON.parse(loader.doctorJson());
    assert.equal(entry.observability.spanCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports per-extension error count and last error for boundary failures", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "flaky.js"),
      [
        "let n = 0;",
        "export default (pi) => {",
        '  pi.on("session_end", () => { throw new Error("boom " + (++n)); });',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    await loader.notifySessionEnd();
    await loader.notifySessionEnd();

    const [entry] = JSON.parse(loader.doctorJson());
    assert.equal(entry.errorCount, 2);
    assert.match(entry.lastError ?? "", /boom 2/);
    assert.match(loader.doctor(), /boom 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
