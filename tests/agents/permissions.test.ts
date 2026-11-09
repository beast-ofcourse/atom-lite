import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchPermissionPattern,
  permissionInvocation,
  resolveToolPermission,
} from "../../dist/agents/permissions.js";
import { composePersonaSystemPrompt } from "../../dist/agents/persona.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../dist/agent/system-prompt.js";

test("permission patterns support exact matches and globs", () => {
  assert.equal(matchPermissionPattern("git log*", "git log --oneline"), true);
  assert.equal(matchPermissionPattern("git log*", "git status"), false);
  assert.equal(matchPermissionPattern("*", ""), true);
  assert.equal(matchPermissionPattern("echo a:b*", "echo a:b c"), true);
  assert.equal(matchPermissionPattern("file?.ts", "file1.ts"), true);
  assert.equal(matchPermissionPattern("file?.ts", "file10.ts"), false);
  assert.equal(matchPermissionPattern("a.b", "axb"), false);
});

test("the most specific permission rule wins regardless of declaration order", () => {
  const policy = {
    bash: { "git log*": "allow", "*": "ask" },
  };
  assert.deepEqual(resolveToolPermission(policy, "bash", "git log -1"), {
    decision: "allow",
    pattern: "git log*",
  });
  assert.deepEqual(resolveToolPermission(policy, "bash", "rm -rf build"), {
    decision: "ask",
    pattern: "*",
  });
  assert.equal(resolveToolPermission(policy, "edit", "src/a.ts"), undefined);
});

test("permission invocation picks the meaningful tool argument", () => {
  assert.equal(
    permissionInvocation("bash", { command: "git status" }),
    "git status",
  );
  assert.equal(
    permissionInvocation("webfetch", { url: "https://x.dev" }),
    "https://x.dev",
  );
  assert.equal(permissionInvocation("edit", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(permissionInvocation("todo", { items: [] }), "");
});

test("persona body replaces default role instructions and keeps policy", () => {
  const base =
    "You are Atom-lite.\n\nDefault role: always explain first.\n\nTask discipline:\n- keep the ledger\n\nTool policy:\n- use read before edit";
  const prompt = composePersonaSystemPrompt(base, {
    name: "reviewer",
    body: "Review for correctness.",
  });
  assert.equal(
    prompt,
    "You are Atom-lite.\n\nActive persona: reviewer\n\nReview for correctness.\n\nTask discipline:\n- keep the ledger\n\nTool policy:\n- use read before edit",
  );
  assert.ok(!prompt.includes("Default role"));
  assert.equal(composePersonaSystemPrompt(base, undefined), base);
});

test("custom prompts without policy sections append the persona body", () => {
  const base = "Base tool policy.";
  const prompt = composePersonaSystemPrompt(base, {
    name: "reviewer",
    body: "Review for correctness.",
  });
  assert.equal(
    prompt,
    "Base tool policy.\n\nActive persona: reviewer\n\nReview for correctness.",
  );
  assert.equal(
    composePersonaSystemPrompt(base, { name: "empty", body: "  " }),
    base,
  );
});

test("default system prompt keeps the persona policy marker splittable", () => {
  // composePersonaSystemPrompt replaces role instructions with the active
  // persona body by slicing on the "\n\nTask discipline:" marker. If this
  // prompt loses the marker (e.g. a rewrite renames the section), persona
  // bodies stop replacing role instructions — a silent behavior regression.
  const prompt = composePersonaSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
    name: "reviewer",
    body: "Review for correctness.",
  });
  assert.ok(prompt.includes("Review for correctness."));
  assert.ok(!prompt.includes("Read context before editing"));
  assert.ok(prompt.includes("Task discipline:"));
  assert.ok(prompt.includes("Tools:"));
});
