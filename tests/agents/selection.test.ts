import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DefaultAgentRegistry } from "../../dist/agents/registry.js";
import { resolveConfiguredAgent } from "../../dist/agents/selection.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const dirs = {
  bundled: join(fixtureRoot, "bundled"),
  global: join(fixtureRoot, "global"),
  project: join(fixtureRoot, "project"),
  opencode: join(fixtureRoot, "opencode"),
};

test("no configured agent leaves the runtime on its default prompt", () => {
  const registry = new DefaultAgentRegistry("", {
    dirs,
    projectTrusted: true,
  });
  assert.deepEqual(resolveConfiguredAgent(registry, undefined), {});
  assert.deepEqual(resolveConfiguredAgent(registry, ""), {});
});

test("a configured primary persona resolves from the registry", () => {
  const registry = new DefaultAgentRegistry("", {
    dirs,
    projectTrusted: true,
  });
  const selection = resolveConfiguredAgent(registry, "planner");
  assert.equal(selection.persona?.name, "planner");
  assert.equal(selection.persona?.source, "project");
  assert.equal(selection.warning, undefined);
});

test("unknown and non-primary configured names produce clear warnings", () => {
  const registry = new DefaultAgentRegistry("", {
    dirs,
    projectTrusted: true,
  });
  assert.deepEqual(resolveConfiguredAgent(registry, "missing"), {
    warning: 'configured agent "missing" was not found',
  });
  assert.deepEqual(resolveConfiguredAgent(registry, "subagent"), {
    warning: 'configured agent "subagent" is not a primary agent',
  });
});

test("untrusted project personas report trust as the blocker", () => {
  const registry = new DefaultAgentRegistry("", {
    dirs,
    projectTrusted: false,
  });
  assert.deepEqual(resolveConfiguredAgent(registry, "subagent"), {
    warning:
      'configured agent "subagent" is project-local and this project is not trusted',
  });
});
