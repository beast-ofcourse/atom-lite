// Skill discovery: project skills override global on name collision, and the
// cache signature changes when skill files change.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultSkillRegistry,
  skillCacheSignature,
} from "../../dist/skills/registry.js";

function skillDir(ws: string, name: string, description: string): void {
  const dir = join(ws, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nbody\n`,
  );
}

test("discovers project skills with frontmatter metadata", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(ws, "my-skill", "does things");
  const reg = new DefaultSkillRegistry(ws);
  const mine = reg.list().filter((s) => s.name === "my-skill");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].scope, "project");
  assert.match(mine[0].description, /does things/);
  // load returns the full file including frontmatter
  const text = reg.load("my-skill");
  assert.ok(text?.includes("body"));
});

test("load of an unknown skill returns undefined", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  const reg = new DefaultSkillRegistry(ws);
  assert.equal(reg.load("never-existed"), undefined);
});

test("directories without SKILL.md or name are ignored", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(ws, "good", "ok");
  mkdirSync(join(ws, ".agents", "skills", "noskillfile"), { recursive: true });
  mkdirSync(join(ws, ".agents", "skills", "noname"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "noname", "SKILL.md"), "# x\n");
  const reg = new DefaultSkillRegistry(ws);
  const names = reg.list().map((s) => s.name);
  assert.ok(names.includes("good"));
  assert.ok(!names.includes("noskillfile"));
  assert.ok(!names.includes("noname"));
});

test("indexText lists skills for the system prompt", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(ws, "alpha", "first");
  const reg = new DefaultSkillRegistry(ws);
  const text = reg.indexText();
  assert.match(text, /Available skills:/);
  assert.match(text, /- alpha: first/);
  // Bundled skills (shipped in the repo's skills/ dir) are always present.
  assert.ok(reg.list().some((s) => s.name === "caveman"));
});

test("skillCacheSignature changes when a project skill file changes", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-sig-"));
  const before = skillCacheSignature(ws);
  skillDir(ws, "new-skill", "x");
  const after = skillCacheSignature(ws);
  assert.notEqual(before, after);
  // Touch the file's mtime: signature must change so caches invalidate.
  const file = join(ws, ".agents", "skills", "new-skill", "SKILL.md");
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
  assert.notEqual(after, skillCacheSignature(ws));
});

test("signature is stable for an unchanged workspace", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-stable-"));
  skillDir(ws, "stable", "y");
  assert.equal(skillCacheSignature(ws), skillCacheSignature(ws));
});

test("missing project skills dir still yields a signature", () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-none-"));
  rmSync(join(ws, ".agents", "skills"), { recursive: true, force: true });
  assert.equal(typeof skillCacheSignature(ws), "string");
});
