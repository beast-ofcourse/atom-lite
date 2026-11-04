import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverExtensions,
  formatExtensionDiscovery,
} from "../../dist/extensions/discovery.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-extensions-"));
}

test("discovers top-level js and mjs files", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alpha.js"), "export default () => {};\n");
    writeFileSync(join(dir, "beta.mjs"), "export default () => {};\n");
    writeFileSync(join(dir, "ignored.txt"), "nope");
    const found = discoverExtensions({ userDir: dir });
    assert.deepEqual(
      found.map((entry) => entry.id).sort(),
      ["alpha", "beta"],
    );
    assert.ok(found.every((entry) => entry.errors.length === 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers index files in one-level directories", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "gamma"));
    writeFileSync(join(dir, "gamma", "index.js"), "export default () => {};\n");
    const found = discoverExtensions({ userDir: dir });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "gamma");
    assert.match(found[0].entryPath, /gamma[\\/]index\.js$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers packaged extensions from package.json", () => {
  const dir = tempDir();
  try {
    const packageDir = join(dir, "pkg");
    mkdirSync(packageDir);
    mkdirSync(join(packageDir, "src"));
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "example-extension",
        version: "1.2.3",
        atom: {
          extensions: ["./src/index.js", "./src/extra.mjs"],
          capabilities: ["tools", "commands"],
          engines: { "atom-lite": ">=0.3.0" },
        },
      }),
    );
    writeFileSync(join(packageDir, "src", "index.js"), "export default () => {};\n");
    writeFileSync(join(packageDir, "src", "extra.mjs"), "export default () => {};\n");

    const found = discoverExtensions({ userDir: dir });
    assert.equal(found.length, 2);
    assert.ok(found.every((entry) => entry.manifest?.name === "example-extension"));
    assert.ok(found.every((entry) => entry.manifest?.version === "1.2.3"));
    assert.deepEqual(
      found[0].manifest?.capabilities,
      ["tools", "commands"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports invalid manifests without executing them", () => {
  const dir = tempDir();
  try {
    const packageDir = join(dir, "bad");
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "bad", atom: { extensions: [] } }),
    );

    const found = discoverExtensions({ userDir: dir });
    assert.equal(found.length, 1);
    assert.ok(found[0].errors.length > 0);
    assert.match(found[0].errors.join("\n"), /non-empty array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers missing packaged entry paths as errors", () => {
  const dir = tempDir();
  try {
    const packageDir = join(dir, "missing-entry");
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ atom: { extensions: ["./nope.js"] } }),
    );

    const found = discoverExtensions({ userDir: dir });
    assert.equal(found.length, 1);
    assert.match(found[0].errors.join("\n"), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli paths can point at files or directories", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "direct.js");
    writeFileSync(file, "export default () => {};\n");
    const nested = join(dir, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "index.js"), "export default () => {};\n");

    const found = discoverExtensions({ cliPaths: [file, nested] });
    assert.equal(found.length, 2);
    assert.ok(found.every((entry) => entry.source === "cli"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formats discovery results", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "alpha.js"), "export default () => {};\n");
    const found = discoverExtensions({ userDir: dir });
    const output = formatExtensionDiscovery(found);
    assert.match(output, /^user\talpha\t/);
    assert.match(output, /\tok$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
