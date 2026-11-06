const { execSync } = require("node:child_process");
const out = execSync("node b.js", { encoding: "utf8" }).trim();
if (out !== "newName works") { console.error("expected 'newName works', got " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
