// Contract tests for ticket 09 (provider and mode gates).
//
// Seams under test:
//   - ExtensionLoader.loadAll(): loading an extension that imports Pi host
//     modules must not write shim files into node_modules, and an unknown host
//     module must fail the extension loudly rather than being stubbed.
//   - compareVersionNames(): release directories are ordered numerically, so
//     version 10 wins over version 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersionNames,
  ExtensionLoader,
} from "../../dist/extensions/loader.js";

function tempTree(): { root: string; workspace: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "atom-lite-hostmod-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, workspace, outside };
}

test("load creates no shim artifacts outside the workspace", async () => {
  const { root, workspace, outside } = tempTree();
  try {
    writeFileSync(
      join(workspace, "hosty.js"),
      [
        'import { Type } from "@mariozechner/pi-ai";',
        'import { Agent } from "@mariozechner/pi-agent-core";',
        'import { anything } from "@mariozechner/pi-coding-agent";',
        "export default (api) => {",
        "  api.registerTool({ name: 'hosty', label: 'h', description: 'd', execute: async () => 'ok' });",
        "};",
        "",
      ].join("\n"),
    );
    const cwd = process.cwd();
    try {
      process.chdir(outside);
      const loader = new ExtensionLoader({
        cwd: workspace,
        userDir: workspace,
        agentDir: join(workspace, "agent"),
      });
      const loaded = await loader.loadAll();
      assert.equal(loaded[0].status, "loaded", loaded[0].error);
      assert.equal(loaded[0].registries.tools.size, 1);
    } finally {
      process.chdir(cwd);
    }
    for (const dir of [outside, workspace]) {
      assert.equal(
        existsSync(join(dir, "node_modules", ".atom-lite-shims")),
        false,
        `wrote shims into ${dir}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuinely missing host module fails the extension loudly", async () => {
  const { root, workspace } = tempTree();
  try {
    writeFileSync(
      join(workspace, "missing-host.js"),
      'import { nope } from "pi-module-that-does-not-exist";\nexport default () => { void nope; };\n',
    );
    const loader = new ExtensionLoader({
      cwd: workspace,
      userDir: workspace,
      agentDir: join(workspace, "agent"),
    });
    const loaded = await loader.loadAll();
    assert.equal(loaded[0].status, "error");
    assert.match(
      loaded[0].error ?? "",
      /pi-module-that-does-not-exist|Cannot find module/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 9 does not beat 10 when picking the latest release", () => {
  assert.ok(compareVersionNames("9", "10") < 0);
  assert.deepEqual(["9", "10", "2"].sort(compareVersionNames), [
    "2",
    "9",
    "10",
  ]);
  assert.ok(compareVersionNames("1.9.0", "1.10.0") < 0);
});
