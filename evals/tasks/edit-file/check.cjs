import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const p = join(process.cwd(), "config.json");
if (!existsSync(p)) { console.error("missing config.json"); process.exit(1); }
const j = JSON.parse(readFileSync(p, "utf8"));
if (j.x !== 2) { console.error("expected x=2, got " + j.x); process.exit(1); }
console.log("ok");
