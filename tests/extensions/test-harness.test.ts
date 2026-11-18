// Contract tests for ticket 14 (extension test harness).
//
// Seams under test:
//   - runExtensionTest(): loads a fixture through the normal extension loader
//     with a fake provider, fake TUI and fake session; no real network.
//   - ExtensionTestContext: assert / runTurn / tools / transcript / events /
//     uiEvents / sessionEvents / doctor are the public seams a fixture uses.
//   - Exit result: any failed assertion or extension error fails the run.
//
// Each test names the failure it pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExtensionTest } from "../../dist/extensions/harness.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-test-harness-"));
}

test("harness runs a fixture with fakes and exposes transcript, tools and events", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "working.js");
    writeFileSync(
      fixture,
      [
        "let api;",
        "export default (pi) => {",
        "  api = pi;",
        "  pi.registerTool({",
        "    name: 'echo', label: 'Echo', description: 'echo text',",
        "    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
        "    execute: async (_id, args) => args.text,",
        "  });",
        '  pi.on("turn_end", () => {});',
        "};",
        "export async function test(ctx) {",
        "  ctx.assert.equal(ctx.tools.length, 1);",
        "  const turn = await ctx.runTurn('hello');",
        "  ctx.assert.match(turn.text, /echo:hello/);",
        "  ctx.assert.ok(ctx.transcript.some(m => m.role === 'user' && m.content === 'hello'));",
        "  ctx.assert.ok(ctx.events.includes('turn_end'));",
        "  const value = await ctx.tools[0].execute('call-1', { text: 'ping' });",
        "  ctx.assert.equal(value, 'ping');",
        "  ctx.assert.ok(ctx.transcript.some(m => m.role === 'tool' && /ping/.test(m.content)));",
        "  api.ui.notify('hello from fake tui');",
        "  ctx.assert.ok(ctx.uiEvents.some(e => /hello from fake tui/.test(e.message)));",
        "  api.appendEntry('note', { ok: true });",
        "  ctx.assert.equal(ctx.sessionEvents.length, 1);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.errors.length, 0);
    assert.ok(result.assertions >= 8, "every fixture assertion ran");
    assert.ok(result.output.some((line) => /PASS|passed/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing assertion fails the harness run", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "fails.js");
    writeFileSync(
      fixture,
      [
        "export default () => {};",
        "export function test(ctx) { ctx.assert.equal(1, 2, 'one is two'); }",
        "",
      ].join("\n"),
    );
    const result = await runExtensionTest(fixture);
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /one is two/);
    assert.ok(result.output.some((line) => /one is two/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extension error fails the harness run and is visible in doctor", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "explodes.js");
    writeFileSync(
      fixture,
      [
        "export default () => { throw new Error('activation exploded'); };",
        "export function test(ctx) {",
        "  ctx.assert.ok(true);",
        "  const [entry] = ctx.doctor();",
        "  ctx.assert.equal(entry.status, 'error');",
        "}",
        "",
      ].join("\n"),
    );
    const result = await runExtensionTest(fixture);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => /activation exploded/.test(error)));
    assert.match(result.output.join("\n"), /activation exploded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fixture without a test export fails with a clear message", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "no-test.js");
    writeFileSync(fixture, "export default () => {};\n");
    const result = await runExtensionTest(fixture);
    assert.equal(result.passed, false);
    assert.match(result.errors.join("\n"), /must export test\(ctx\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
