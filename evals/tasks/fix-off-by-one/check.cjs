const sum = require("./src/sum.js");
const r = sum([1, 2, 3]);
if (r !== 6) {
  console.error("expected 6, got " + r);
  process.exit(1);
}
console.log("ok");
