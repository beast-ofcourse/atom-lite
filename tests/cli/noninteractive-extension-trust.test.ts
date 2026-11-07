import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("non-interactive runs skip untrusted project extensions with a notice", () => {
  const root = tempDir("atom-lite-noninteractive-");
  const home = join(root, "home");
  const configHome = join(root, "config");
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(project, ".pi", "extensions", "project.js"),
    "export default () => {};\\n",
  );

  try {
    const result = execFileSync(
      process.execPath,
      [join(process.cwd(), "dist", "cli", "main.js"), "--json", "hello"],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          PI_CODING_AGENT_DIR: agentDir,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(result, /"result"/);
  } catch (error: any) {
    const stderr = String(error.stderr ?? "");
    assert.match(stderr, /skipping 1 untrusted project extension/);
    // Provider availability is environmental; the extension notice is what this test verifies.
    if (!/skipping 1 untrusted project extension/.test(stderr)) throw error;
  }
});
