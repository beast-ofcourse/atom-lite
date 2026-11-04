import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpEnv } from "../../dist/mcp/stdio-transport.js";

test("buildMcpEnv keeps allowlisted vars and declared vars, drops secrets", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "secret",
    ATOM_LITE_MODEL: "x",
    XDG_CONFIG_HOME: "/cfg",
  } as any;
  const env = buildMcpEnv({ FOO: "bar" }, base);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(env.XDG_CONFIG_HOME, "/cfg");
  assert.equal(env.FOO, "bar");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ATOM_LITE_MODEL, undefined);
});
