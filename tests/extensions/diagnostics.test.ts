import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compatibilityMatrix } from "../../dist/extensions/compatibility-matrix.js";
import { compatibilityMethodNames } from "../../dist/extensions/compatibility-matrix.js";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { createCommandRegistry } from "../../dist/cli/commands.js";

const ROOT = join(import.meta.dirname, "..", "..");

function interfaceMethods(file: string, name: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const body = new RegExp(
    `export interface ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source)?.[1];
  assert.ok(body, `interface ${name} not found in ${file}`);
  return [...body.matchAll(/^\s{2}([A-Za-z_]\w*)[?]?:?\s*\(/gm)].map(
    (match) => match[1],
  );
}

test("compatibility matrix covers every ExtensionAPI method", () => {
  const expected = interfaceMethods("src/extensions/api.ts", "ExtensionAPI");
  const actual = compatibilityMatrix.map((entry) => entry.method);
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("every supported matrix entry has a resolvable consumer", () => {
  for (const entry of compatibilityMatrix) {
    if (entry.status !== "supported") continue;
    assert.ok(
      entry.consumers.length > 0,
      `${entry.method} is supported but has no consumer`,
    );
    for (const consumer of entry.consumers as any[]) {
      assert.equal(typeof consumer.file, "string", `${entry.method}: consumer file`);
      assert.equal(typeof consumer.line, "number", `${entry.method}: consumer line`);
      assert.notEqual(
        consumer.file,
        "src/extensions/api.ts",
        `${entry.method}: a supported consumer must be a host reader, not the implementation`,
      );
      const lines = readFileSync(join(ROOT, consumer.file), "utf8").split("\n");
      const sourceLine = lines[consumer.line - 1];
      assert.ok(
        sourceLine && sourceLine.trim().length > 0,
        `${entry.method}: consumer ${consumer.file}:${consumer.line} is empty`,
      );
    }
  }
});

test("matrix status comes from host consumers, not self references", () => {
  const statuses: Record<string, string> = {
    setActiveTools: "supported",
    getActiveTools: "supported",
    setStatus: "no-op",
    registerFlag: "no-op",
    getFlag: "no-op",
    appendEntry: "reduced",
    getSessionEntries: "reduced",
    notify: "reduced",
    exec: "reduced",
    log: "reduced",
  };
  for (const [method, status] of Object.entries(statuses)) {
    const entry = compatibilityMatrix.find((row) => row.method === method);
    assert.ok(entry, `missing matrix entry for ${method}`);
    assert.equal(entry!.status, status, method);
  }
  for (const method of ["setActiveTools", "getActiveTools"]) {
    const entry = compatibilityMatrix.find((row) => row.method === method)!;
    assert.ok(
      (entry.consumers as any[]).some(
        (consumer) => consumer.file === "src/extensions/tool-adapter.ts",
      ),
      `${method}: host reader missing from tool-adapter.ts`,
    );
  }
});

test("generated matrix is current", () => {
  execFileSync(process.execPath, ["scripts/generate-compatibility-matrix.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
});

test("doctor --json reports a broken extension with stack and only real APIs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-doctor-"));
  try {
    writeFileSync(
      join(dir, "broken.js"),
      [
        "export default (pi) => {",
        "  pi.registerTool({ name: 'x' });",
        "  pi.on('tool_call', () => {});",
        "  throw new Error('activation failed');",
        "};",
        "",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();
    const entries = JSON.parse(loader.doctorJson());
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.id, "broken");
    assert.equal(entry.status, "error");
    assert.match(entry.error, /activation failed/);
    assert.match(entry.stack, /broken\.js/);
    assert.equal(typeof entry.toolCount, "number");
    assert.equal(typeof entry.commandCount, "number");
    assert.equal(typeof entry.eventCount, "number");
    assert.ok(entry.apis.length > 0);
    for (const api of entry.apis) {
      assert.ok(compatibilityMethodNames.includes(api.method));
      assert.ok(
        compatibilityMatrix.some(
          (row) =>
            row.method === api.method &&
            row.status === api.status &&
            JSON.stringify(row.consumers) === JSON.stringify(api.consumers),
        ),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DOC_FILES = [
  "docs/extensions.md",
  "skills/atom-lite-extensions/SKILL.md",
  ".agents/skills/atom-lite-extensions/SKILL.md",
];

function documentedMethods(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of [
    /\b(?:pi|atom)\.([A-Za-z_]\w*)\s*\(/g,
    /\bpi\.ui\.([A-Za-z_]\w*)\s*\(/g,
    /`([A-Za-z_]\w*)\(/g,
  ]) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

test("published docs and skills name only methods the API exposes", () => {
  const allowed = new Set([
    "ui", // pi.ui property, matched as a call prefix above
    ...interfaceMethods("src/extensions/api.ts", "ExtensionAPI"),
    ...interfaceMethods("src/extensions/types.ts", "ExtensionUIContext"),
    ...interfaceMethods("src/extensions/types.ts", "ExtensionCommand"),
    ...interfaceMethods("src/extensions/types.ts", "ExtensionWidget"),
    ...interfaceMethods("src/extensions/types.ts", "ExtensionTool"),
  ]);
  for (const file of DOC_FILES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const method of documentedMethods(text)) {
      assert.ok(allowed.has(method), `${file}: undocumented method '${method}'`);
    }
  }
});

test("published docs and skills carry no stale claims", () => {
  const stale = [
    /1\.4\.x/i,
    /1\.4\.0/,
    /conformance fixture/i,
    /fail loudly/i,
    /assistant_delta|assistant_text|thinking_delta|agent_start|agent_end|context_usage|model_switched/,
    /run\s*\(\s*ctx\s*,\s*args/,
    /virtualModel/,
    /EOF/,
    /echo\s+"written"/,
  ];
  for (const file of DOC_FILES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const pattern of stale) {
      assert.ok(!pattern.test(text), `${file}: stale claim ${pattern}`);
    }
  }
});

test("extension docs point at the generated matrix", () => {
  const text = readFileSync(join(ROOT, "docs/extensions.md"), "utf8");
  assert.match(text, /compatibility-matrix\.ts/);
  assert.match(text, /matrix:generate/);
  for (const status of ["supported", "reduced", "no-op", "unsupported"]) {
    assert.match(text, new RegExp(`\\b${status}\\b`));
  }
});

test("/extensions doctor --json dispatches to the JSON doctor hook", () => {
  const lines: string[] = [];
  const json = JSON.stringify([{ id: "broken", status: "error" }]);
  const ctx = {
    appendLine: (text: string) => lines.push(text),
    extensionDoctor: () => "text doctor",
    extensionDoctorJson: () => json,
    listExtensions: () => "extension list",
  } as any;
  const registry = createCommandRegistry({ skills: [] });
  const command = registry.get("extensions");
  assert.ok(command);
  command!.run(ctx, "doctor --json");
  assert.deepEqual(lines, [json]);

  lines.length = 0;
  command!.run(ctx, "doctor");
  assert.deepEqual(lines, ["text doctor"]);

  lines.length = 0;
  command!.run(ctx, "");
  assert.deepEqual(lines, ["extension list"]);
});

test("doctor --json reports a clean extension without an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-doctor-"));
  try {
    writeFileSync(join(dir, "clean.js"), "export default () => {};\n");
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();
    const [entry] = JSON.parse(loader.doctorJson());
    assert.equal(entry.status, "loaded");
    assert.equal(entry.error, undefined);
    assert.equal(entry.stack, undefined);
    assert.deepEqual(entry.apis, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
