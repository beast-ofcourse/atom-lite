import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

if (!pkg.dependencies?.wasmoon) {
  throw new Error("wasmoon must be a direct dependency to publish Lua support");
}

const wasmoonDir = dirname(require.resolve("wasmoon/package.json"));
const wasmAsset = resolve(wasmoonDir, "dist/glue.wasm");
if (!existsSync(wasmAsset)) {
  throw new Error(`wasmoon runtime asset missing: ${wasmAsset}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tarballs = JSON.parse(
  execFileSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const packed = Array.isArray(tarballs)
  ? tarballs[0]
  : Object.values(tarballs)[0];
const paths = packed.files.map((file) => file.path);
for (const required of [
  "dist/extensions/lua.js",
  "dist/extensions/loader.js",
]) {
  if (!paths.includes(required)) {
    throw new Error(`publishable artifact is missing ${required}`);
  }
}

console.log(
  `lua packaging ok: wasmoon ${pkg.dependencies.wasmoon}, asset ${wasmAsset}, tarball includes Lua runtime`,
);
