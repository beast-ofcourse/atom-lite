const { execSync } = require("node:child_process");
let out = "";
try {
  out = execSync("node main.js", { encoding: "utf8", timeout: 5000 }).trim();
} catch (e) {
  console.error("did not terminate or errored: " + (e.message || e));
  process.exit(1);
}
if (!out.split("\n").includes("done")) { console.error("expected 'done' in output, got: " + out); process.exit(1); }
console.log("ok");
