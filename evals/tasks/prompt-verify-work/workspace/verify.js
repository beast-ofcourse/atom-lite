const { sumTo } = require("./src/sum");
if (sumTo(4) !== 10) { console.error("fail", sumTo(4)); process.exit(1); }
console.log("pass");