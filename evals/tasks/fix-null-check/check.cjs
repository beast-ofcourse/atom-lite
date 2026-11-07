const { getDisplayName } = require("./user");
let ok = true;
if (getDisplayName(null) !== "Anonymous") {
  console.error("null case failed");
  ok = false;
}
if (getDisplayName(undefined) !== "Anonymous") {
  console.error("undefined case failed");
  ok = false;
}
if (getDisplayName({ name: "Ada" }) !== "Ada") {
  console.error("name case failed");
  ok = false;
}
process.exit(ok ? 0 : 1);
