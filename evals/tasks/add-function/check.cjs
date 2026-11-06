const m = require("./math.js");
if (typeof m.multiply !== "function") { console.error("multiply not exported"); process.exit(1); }
if (m.multiply(3, 4) !== 12) { console.error("expected 12, got " + m.multiply(3, 4)); process.exit(1); }
if (m.add(1, 2) !== 3) { console.error("add broken"); process.exit(1); }
console.log("ok");
