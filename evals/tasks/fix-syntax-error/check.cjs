const { execSync } = require("node:child_process");
let out = "";
try {
  out = execSync("node main.js", { encoding: "utf8", timeout: 5000 }).trim();
} catch (e) {
  console.error("failed to run: " + (e.stderr || e.message));
  process.exit(1);
}
if (out !== "Hello, world") {
  console.error("expected 'Hello, world', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
