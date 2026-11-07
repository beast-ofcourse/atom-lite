const { execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
if (!existsSync("tests/add.test.js") && !existsSync("test/add.test.js")) {
  console.error("no test file created");
  process.exit(1);
}
try {
  execSync("node --test", { stdio: "pipe" });
  console.log("ok");
} catch (e) {
  console.error("tests failed: " + (e.stderr || e.message));
  process.exit(1);
}
