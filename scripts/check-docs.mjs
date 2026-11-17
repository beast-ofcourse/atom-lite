// docs:check — guardrails for the published documentation system.
// Verifies relative links, config-field coverage, and the private-ADR rule.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const docsDir = join(root, "docs");
const files = [join(root, "README.md"), ...markdownFiles(docsDir)];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relativePath = relative(root, file);
  const links = [
    ...text.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
  ].map((match) => match[1]);
  for (const link of links) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const target = decodeURIComponent(link.split("#")[0]);
    if (!target) continue;
    if (/(^|\/)(adr|\.scratch|temp)\//.test(target)) {
      failures.push(`${relativePath}: link to private path '${link}'`);
      continue;
    }
    const absolute = resolve(dirname(file), target);
    try {
      statSync(absolute);
    } catch {
      failures.push(`${relativePath}: broken link '${link}'`);
    }
  }
}

const configDoc = readFileSync(join(docsDir, "config.md"), "utf8");
const schema = readFileSync(join(root, "src", "config", "schema.ts"), "utf8");
const keys = new Set(
  [...schema.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map(
    (match) => match[1],
  ),
);
for (const key of keys) {
  if (!configDoc.includes(`\`${key}\``)) {
    failures.push(`docs/config.md: missing config field '${key}'`);
  }
}

// The eval page is the published source of truth for the harness. Keep it
// present and discoverable from the docs index and the documentation skill.
const evalDoc = join(docsDir, "eval.md");
let evalPresent = true;
try {
  statSync(evalDoc);
} catch {
  evalPresent = false;
  failures.push("docs/eval.md: missing eval documentation page");
}
if (evalPresent) {
  const evalIndex = readFileSync(join(docsDir, "README.md"), "utf8");
  if (!/\]\(\.\/eval\.md(?:\s+"[^"]*")?\)/.test(evalIndex)) {
    failures.push("docs/README.md: missing link to the eval page (./eval.md)");
  }
  const docsSkill = readFileSync(
    join(root, ".agents", "skills", "atom-lite-docs", "SKILL.md"),
    "utf8",
  );
  if (!docsSkill.includes("docs/eval.md")) {
    failures.push(
      ".agents/skills/atom-lite-docs/SKILL.md: missing docs/eval.md in page map",
    );
  }
}

if (failures.length > 0) {
  console.error(`docs:check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `docs:check ok: ${files.length} markdown files, ${keys.size} config fields, no private links`,
);
