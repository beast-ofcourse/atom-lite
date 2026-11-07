import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverExtensions } from "../../dist/extensions/discovery.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-pi-discovery-"));
}

function piExtension(
  dir: string,
  name: string,
  body = "export default () => {};\n",
) {
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", name), body);
}

test("discovers Pi project extensions and marks them untrusted by default", () => {
  const dir = tempDir();
  try {
    piExtension(dir, "alpha.ts");
    const found = discoverExtensions({ cwd: dir });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "alpha");
    assert.equal(found[0].source, "project");
    assert.match(found[0].entryPath, /\.pi[\\/]extensions[\\/]alpha\.ts$/);
    assert.equal(found[0].trusted, false);
    assert.match(found[0].skipReason ?? "", /not trusted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving a project marks its extensions trusted", () => {
  const dir = tempDir();
  try {
    piExtension(dir, "alpha.ts");
    const found = discoverExtensions({ cwd: dir, trustedProjects: [dir] });
    assert.equal(found[0].trusted, true);
    assert.equal(found[0].skipReason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denying a project marks its extensions denied", () => {
  const dir = tempDir();
  try {
    piExtension(dir, "alpha.ts");
    const found = discoverExtensions({ cwd: dir, deniedProjects: [dir] });
    assert.equal(found[0].trusted, false);
    assert.match(found[0].skipReason ?? "", /denied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses Pi package manifests and their entrypoints", () => {
  const dir = tempDir();
  try {
    const packageDir = join(dir, "node_modules", "pi-tools");
    mkdirSync(join(packageDir, "src"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "pi-tools",
        version: "2.0.0",
        pi: { extensions: ["./src/one.ts", "./src/two.ts"] },
      }),
    );
    writeFileSync(
      join(packageDir, "src", "one.ts"),
      "export default () => {};\n",
    );
    writeFileSync(
      join(packageDir, "src", "two.ts"),
      "export default () => {};\n",
    );

    const found = discoverExtensions({ userDir: join(dir, "node_modules") });
    assert.equal(found.length, 2);
    assert.ok(found.every((entry) => entry.manifest?.kind === "pi"));
    assert.ok(found.every((entry) => entry.manifest?.name === "pi-tools"));
    assert.ok(found.every((entry) => entry.manifest?.version === "2.0.0"));
    assert.deepEqual(found[0].manifest?.capabilities, []);
    assert.equal(new Set(found.map((entry) => entry.id)).size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves index files in Pi order: ts, js, mjs", () => {
  const dir = tempDir();
  try {
    const extensionDir = join(dir, "entry-order");
    mkdirSync(extensionDir);
    writeFileSync(
      join(extensionDir, "index.mjs"),
      "export default () => {};\n",
    );
    writeFileSync(join(extensionDir, "index.js"), "export default () => {};\n");
    writeFileSync(join(extensionDir, "index.ts"), "export default () => {};\n");

    const found = discoverExtensions({ userDir: dir });
    assert.equal(found.length, 1);
    assert.match(found[0].entryPath, /index\.ts$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads extension paths from global and project Pi settings", () => {
  const dir = tempDir();
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: ["./global-ext.ts"] }),
    );
    writeFileSync(
      join(agentDir, "global-ext.ts"),
      "export default () => {};\n",
    );

    const projectDir = join(dir, "project");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["../project-ext.ts"] }),
    );
    writeFileSync(
      join(projectDir, "project-ext.ts"),
      "export default () => {};\n",
    );

    const found = discoverExtensions({ cwd: projectDir, agentDir });
    assert.equal(found.length, 2);
    assert.equal(
      found.find((entry) => entry.id === "global-ext")?.source,
      "user",
    );
    const project = found.find((entry) => entry.id === "project-ext");
    assert.equal(project?.source, "project");
    assert.equal(project?.trusted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deduplicates by resolved path with CLI taking precedence", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    const shared = join(dir, ".pi", "extensions", "shared.ts");
    writeFileSync(shared, "export default () => {};\n");

    const found = discoverExtensions({ cwd: dir, cliPaths: [shared] });
    assert.equal(found.length, 1);
    assert.equal(found[0].source, "cli");
    assert.equal(found[0].trusted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
