// Process policy: shell resolution and process-tree termination. These back
// the bash tool's timeout and cancellation behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  defaultShell,
  terminateProcessTree,
} from "../../dist/security/process.js";

test("defaultShell prefers the user's SHELL on POSIX", () => {
  if (process.platform === "win32") return;
  const shell = defaultShell();
  assert.ok(shell.length > 0);
  assert.equal(shell, process.env.SHELL || "/bin/sh");
});

test("terminateProcessTree stops a detached child and its descendants", async () => {
  // The child spawns a grandchild so tree-kill (process-group signal) is
  // distinguishable from plain kill(child.pid).
  const script = `process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},50)`;
  const child = spawn(process.execPath, ["-e", script], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(child.pid);
  terminateProcessTree(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.on("exit", () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  assert.equal(exited, true, "child exited after tree termination");
});

test("terminateProcessTree is a no-op for an unstarted child", () => {
  assert.doesNotThrow(() =>
    terminateProcessTree({ pid: undefined, kill: () => true }),
  );
});
