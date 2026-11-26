import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExtensionTest } from "../../dist/extensions/harness.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-lua-runtime-"));
}

test("a Lua extension loads, registers a tool, and passes its test(ctx)", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "echo.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({",
        "    name = 'echo', label = 'Echo', description = 'echo text',",
        "    parameters = { type = 'object', properties = { text = { type = 'string' } }, required = { 'text' } },",
        "    execute = function(id, args)",
        "      return args.text",
        "    end",
        "  })",
        "end",
        "",
        "test = function(ctx)",
        "  ctx.assert.equal(ctx.tools.length, 1)",
        "  local value = ctx.tools[1].execute('call-1', { text = 'ping' }):await()",
        "  ctx.assert.equal(value, 'ping')",
        "end",
        "",
      ].join("\n"),
    );

    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\\n"),
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
