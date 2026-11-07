const { execSync } = require("node:child_process");
const out = execSync("node main.js", { encoding: "utf8" }).trim();
if (out !== "ok") {
  console.error("expected 'ok', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
