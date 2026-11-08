import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DefaultAgentRegistry,
  defaultAgentDirs,
} from "../../dist/agents/registry.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

const fixtureDirs = {
  bundled: join(fixtureRoot, "bundled"),
  global: join(fixtureRoot, "global"),
  project: join(fixtureRoot, "project"),
  opencode: join(fixtureRoot, "opencode"),
};

function fixtureRegistry(projectTrusted = true) {
  return new DefaultAgentRegistry("", { dirs: fixtureDirs, projectTrusted });
}

test("discovers primary personas with body, temperature, and source", () => {
  const registry = fixtureRegistry();
  const planner = registry.get("planner");
  assert.ok(planner);
  assert.equal(planner.source, "project");
  assert.equal(planner.mode, "primary");
  assert.equal(planner.description, "Project planner.");
  assert.equal(planner.temperature, 0.2);
  assert.equal(planner.body, "Project planner body with **markdown**.");
  assert.match(planner.path, /project[\\/]planner\.md$/);
});

test("parses nested permission globs and normalizes flat tool decisions", () => {
  const planner = fixtureRegistry().get("planner");
  assert.deepEqual(planner?.permissions, {
    bash: {
      "*": "ask",
      "git log*": "allow",
      "echo a:b*": "deny",
    },
    edit: { "*": "allow" },
    write: { "*": "deny" },
    webfetch: { "docs.*": "ask" },
  });
});

test("uses the frontmatter name over the file name", () => {
  const registry = fixtureRegistry();
  assert.ok(registry.get("architect"));
  assert.equal(registry.get("renamed"), undefined);
  assert.equal(
    registry.get("architect")?.body,
    "Design systems before writing code.",
  );
});

test("precedence: project beats opencode beats global beats bundled", () => {
  const registry = fixtureRegistry();
  // planner exists in bundled, global, and project.
  assert.equal(registry.get("planner")?.source, "project");
  assert.equal(registry.get("planner")?.temperature, 0.2);
  // reviewer exists in global and opencode; project has no canonical copy.
  assert.equal(registry.get("reviewer")?.source, "opencode");
  assert.equal(registry.get("reviewer")?.body, "Opencode reviewer body.");
});

test("skips project and opencode personas until the project is trusted", () => {
  const registry = fixtureRegistry(false);
  // Project planner is hidden, so the global copy wins.
  assert.equal(registry.get("planner")?.source, "global");
  assert.equal(registry.get("planner")?.body, "Global planner body.");
  // Opencode reviewer is hidden, so the global copy wins.
  assert.equal(registry.get("reviewer")?.source, "global");
  assert.equal(registry.get("subagent"), undefined);
  assert.deepEqual(
    registry
      .untrusted()
      .map((persona) => persona.name)
      .sort(),
    ["planner", "reviewer", "subagent"],
  );
});

test("trusted projects load project and opencode personas normally", () => {
  const registry = fixtureRegistry(true);
  assert.equal(registry.get("planner")?.source, "project");
  assert.equal(registry.get("reviewer")?.source, "opencode");
  assert.equal(registry.get("subagent")?.source, "project");
  assert.deepEqual(registry.untrusted(), []);
});

test("lists subagent personas but excludes them from primary()", () => {
  const registry = fixtureRegistry();
  assert.equal(registry.get("subagent")?.mode, "subagent");
  assert.ok(registry.primary().every((persona) => persona.mode === "primary"));
  assert.ok(!registry.primary().some((persona) => persona.name === "subagent"));
});

test("ignores non-markdown files and missing directories", () => {
  const registry = new DefaultAgentRegistry("", {
    projectTrusted: true,
    dirs: {
      ...fixtureDirs,
      bundled: join(fixtureRoot, "missing"),
      global: join(fixtureRoot, "missing"),
      opencode: join(fixtureRoot, "missing"),
    },
  });
  assert.ok(!registry.list().some((persona) => persona.name === "notes"));
  assert.deepEqual(
    registry.primary().map((persona) => persona.name),
    ["planner"],
  );
});

test("ignores markdown without a persona mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-agents-"));
  try {
    writeFileSync(
      join(dir, "notes.md"),
      "---\ndescription: Not a persona.\n---\nJust notes.\n",
    );
    writeFileSync(
      join(dir, "valid.md"),
      "---\ndescription: Valid.\nmode: primary\n---\nBody.\n",
    );
    const registry = new DefaultAgentRegistry("", {
      dirs: {
        bundled: join(dir, "missing"),
        global: dir,
        project: join(dir, "missing"),
        opencode: join(dir, "missing"),
      },
    });
    assert.deepEqual(
      registry.list().map((persona) => persona.name),
      ["valid"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses CRLF frontmatter and keeps multiline persona bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "atom-lite-agents-"));
  try {
    writeFileSync(
      join(dir, "windows.md"),
      [
        "---",
        "# YAML comments and inline comments are both allowed.",
        "description: 'CRLF persona.' # quoted value",
        "mode: primary",
        "temperature: 0.15",
        "permission:",
        "  bash: # command rules",
        "    '*': ask # default",
        "---",
        "",
        "Line one.",
        "",
        "Line two.",
        "",
      ].join("\r\n"),
    );
    const registry = new DefaultAgentRegistry("", {
      dirs: {
        bundled: join(dir, "missing"),
        global: dir,
        project: join(dir, "missing"),
        opencode: join(dir, "missing"),
      },
    });
    const persona = registry.get("windows");
    assert.equal(persona?.description, "CRLF persona.");
    assert.equal(persona?.temperature, 0.15);
    assert.equal(persona?.body, "Line one.\n\nLine two.");
    assert.deepEqual(persona?.permissions.bash, { "*": "ask" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default directories follow the documented locations", () => {
  const dirs = defaultAgentDirs("/workspace");
  assert.match(dirs.bundled, /agents$/);
  assert.match(dirs.global, /\.config[\\/]atom-lite[\\/]agents$/);
  assert.equal(dirs.project, join("/workspace", ".atom-lite", "agents"));
  assert.equal(dirs.opencode, join("/workspace", ".opencode", "agents"));
});
