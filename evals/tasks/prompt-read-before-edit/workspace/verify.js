const { add } = require("./main");
if (add(2, 3) !== 5) { console.error("fail", add(2, 3)); process.exit(1); }
console.log("pass");