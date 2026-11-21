import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), "src/providers/model-catalog.seed.json");
const data = JSON.parse(readFileSync(file, "utf8"));
const sorted = Object.keys(data)
  .sort()
  .reduce((acc, key) => {
    acc[key] = [...data[key]].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );
    return acc;
  }, {});
writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
console.log("wrote", file);
