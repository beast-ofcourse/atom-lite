// Keep shipped skills byte-identical to their local agent copies.
//   node scripts/sync-skills.mjs          # copy canonical -> local
//   node scripts/sync-skills.mjs --check  # fail when they diverge
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Only skills with two maintained copies. The shipped `skills/` copy is
// canonical; it uses repository URLs that also work outside this checkout.
const pairs = [
  {
    name: "atom-lite-extensions",
    canonical: "skills/atom-lite-extensions/SKILL.md",
    mirror: ".agents/skills/atom-lite-extensions/SKILL.md",
  },
];

const check = process.argv.includes("--check");
let divergent = 0;

for (const pair of pairs) {
  const source = readFileSync(resolve(root, pair.canonical), "utf8");
  const targetPath = resolve(root, pair.mirror);
  let current = "";
  try {
    current = readFileSync(targetPath, "utf8");
  } catch {
    // Missing mirror counts as divergent.
  }
  if (current === source) {
    console.log(`${pair.name}: in sync`);
    continue;
  }
  if (check) {
    console.error(
      `${pair.name}: ${pair.mirror} diverges from ${pair.canonical}`,
    );
    divergent++;
    continue;
  }
  writeFileSync(targetPath, source);
  console.log(`${pair.name}: synced ${pair.mirror}`);
}

if (divergent > 0) process.exit(1);
