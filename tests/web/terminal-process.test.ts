import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeTerminal } from "../../dist/web/terminal-process.js";

test(
  "pipe terminal carries input to output and reports exit when no native PTY is available",
  { skip: process.platform === "win32" ? "POSIX shell required" : false },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipe-terminal-"));
    const child = createPipeTerminal("/bin/cat", { cwd, env: {} });

    const data = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no output received")),
        3000,
      );
      child.onData((text) => {
        if (text.includes("PIPE_OK")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.write("PIPE_OK\n");
    await data;

    const exit = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no exit received")),
        3000,
      );
      child.onExit((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.kill();
    const code = await exit;
    assert.notEqual(code, 0);
    rmSync(cwd, { recursive: true, force: true });
  },
);
