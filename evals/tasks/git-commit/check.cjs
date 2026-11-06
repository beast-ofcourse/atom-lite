const { execSync } = require("node:child_process");
const log = execSync("git log --oneline", { encoding: "utf8" }).trim().split("\n");
if (log.length < 2) { console.error("expected at least 2 commits, got " + log.length); process.exit(1); }
console.log("ok");
