const { execSync } = require("node:child_process");
const out = execSync("node app.js", { encoding: "utf8" }).trim();
if (out !== "NEW_NAME") {
  console.error("expected 'NEW_NAME', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
