// Contract: Pi-style markdown prompt templates become slash commands and
// substitute `$@` with the typed arguments. Project templates require trust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommandRegistry,
  discoverPromptTemplates,
  expandPromptTemplate,
  type CommandContext,
} from "../../dist/cli/commands.js";

const root = mkdtempSync(join(tmpdir(), "atom-prompt-templates-"));
const userDir = join(root, "user");
const projectDir = join(root, "project");
mkdirSync(userDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(userDir, "implement.md"),
  [
    "---",
    "description: Full implementation workflow",
    "---",
    "Implement $@ using the subagent tool.",
  ].join("\n"),
);
writeFileSync(
  join(projectDir, "local.md"),
  "---\ndescription: Local-only prompt\n---\nLocal template $@\n",
);

test("discovers user templates and expands their arguments", () => {
  const templates = discoverPromptTemplates(userDir, [projectDir], false);
  assert.deepEqual(
    templates.map((template) => template.name),
    ["implement"],
  );
  assert.equal(templates[0].description, "Full implementation workflow");
  assert.equal(
    expandPromptTemplate(templates[0].content, "Redis caching"),
    "Implement Redis caching using the subagent tool.",
  );
});

test("arguments containing replacement patterns stay literal", () => {
  assert.equal(
    expandPromptTemplate("Do $@ now", "$& and $`"),
    "Do $& and $` now",
  );
  assert.equal(expandPromptTemplate("Do $ARGUMENTS now", "$$"), "Do $$ now");
});

test("project templates load only when trusted", () => {
  const trusted = discoverPromptTemplates(userDir, [projectDir], true);
  assert.deepEqual(trusted.map((template) => template.name).sort(), [
    "implement",
    "local",
  ]);
});

test("registered template command runs the expanded prompt", async () => {
  const template = discoverPromptTemplates(userDir, projectDir, false)[0];
  const prompts: string[] = [];
  const registry = createCommandRegistry({
    promptTemplates: [template],
  });
  const ctx = {
    runTurn: (prompt: string) => prompts.push(prompt),
    appendLine: () => {},
  } as unknown as CommandContext;
  const result = await registry.dispatch("/implement add caching", ctx);
  assert.equal(result.handled, true);
  assert.deepEqual(prompts, ["Implement add caching using the subagent tool."]);
});
