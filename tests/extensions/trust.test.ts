import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  denyProject,
  isProjectDenied,
  isProjectTrusted,
  trustProject,
  untrustProject,
} from "../../dist/extensions/trust.js";
import { loadConfig } from "../../dist/config/load.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-trust-"));
}

test("trust decisions persist and clear the opposite decision", () => {
  const dir = tempDir();
  const project = join(dir, "project");
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({}));

    trustProject(project, configPath);
    assert.equal(isProjectTrusted(project, configPath), true);
    assert.equal(isProjectDenied(project, configPath), false);

    denyProject(project, configPath);
    assert.equal(isProjectTrusted(project, configPath), false);
    assert.equal(isProjectDenied(project, configPath), true);

    trustProject(project, configPath);
    assert.equal(isProjectTrusted(project, configPath), true);
    assert.equal(isProjectDenied(project, configPath), false);

    untrustProject(project, configPath);
    assert.equal(isProjectTrusted(project, configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads denied project decisions from user config", () => {
  const dir = tempDir();
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        extensions: {
          trustedProjects: ["/trusted"],
          deniedProjects: ["/denied"],
        },
      }),
    );
    const config = loadConfig({ userConfigPath: configPath });
    assert.deepEqual(config.extensions.trustedProjects, ["/trusted"]);
    assert.deepEqual(config.extensions.deniedProjects, ["/denied"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
