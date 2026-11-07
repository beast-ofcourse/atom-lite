const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const p = join(process.cwd(), "hello.txt");
if (!existsSync(p)) {
  console.error("missing hello.txt");
  process.exit(1);
}
const c = readFileSync(p, "utf8");
if (c !== "hi") {
  console.error("expected 'hi', got " + JSON.stringify(c));
  process.exit(1);
}
console.log("ok");
