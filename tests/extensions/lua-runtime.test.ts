import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExtensionLoader,
  type ExtensionLifecycleEvent,
} from "../../dist/extensions/loader.js";
import type { ExtensionAPI } from "../../dist/extensions/api.js";
import { runExtensionTest } from "../../dist/extensions/harness.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-lua-runtime-"));
}

function makeLoader(
  dir: string,
  options: {
    handlerTimeoutMs?: number;
    onLifecycleEvent?: (event: ExtensionLifecycleEvent) => void;
    moduleRuntimes?: ConstructorParameters<
      typeof ExtensionLoader
    >[0]["moduleRuntimes"];
  } = {},
): ExtensionLoader {
  return new ExtensionLoader({
    userDir: dir,
    agentDir: join(dir, "agent"),
    ...options,
  });
}

test("a Lua extension loads, registers a tool, and passes its test(ctx)", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "echo.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({",
        "    name = 'echo', label = 'Echo', description = 'echo text',",
        "    parameters = { type = 'object', properties = { text = { type = 'string' } }, required = { 'text' } },",
        "    execute = function(id, args)",
        "      return args.text",
        "    end",
        "  })",
        "end",
        "",
        "test = function(ctx)",
        "  ctx.assert.equal(ctx.tools.length, 1)",
        "  local value = ctx.tools[1].execute('call-1', { text = 'ping' }):await()",
        "  ctx.assert.equal(value, 'ping')",
        "  local doctor = ctx.doctor()[1]",
        "  ctx.assert.equal(doctor.status, 'loaded')",
        "  ctx.assert.equal(doctor.errorCount, 0)",
        "end",
        "",
      ].join("\n"),
    );

    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("off removes only the handler registered for the named event", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "off.lua");
    writeFileSync(
      fixture,
      [
        "__log = ''",
        "activate = function(pi)",
        "  local function h(ev) __log = __log .. tostring(ev.tag) .. ';' end",
        "  pi.on('turn_start', h)",
        "  pi.on('turn_end', h)",
        "  pi.on('tool_call', h)",
        "  pi.on('before_provider_request', h)",
        "  pi.off('turn_start', h)",
        "end",
        "test = function(ctx)",
        "  ctx.dispatch('turn_start', { tag = 'start' }):await()",
        "  ctx.dispatch('before_provider_request', { tag = 'provider' }):await()",
        "  ctx.dispatch('tool_call', { tag = 'call' }):await()",
        "  ctx.dispatch('turn_end', { tag = 'end' }):await()",
        "  ctx.assert.equal(__log, 'provider;call;end;')",
        "end",
        "",
      ].join("\n"),
    );

    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a synchronous Lua loop is contained as a timeout failure", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "spin.lua"),
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'spin', label = 's', description = 'd',",
        "    execute = function() while true do end end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const errors: ExtensionLifecycleEvent[] = [];
    const loader = makeLoader(dir, {
      handlerTimeoutMs: 200,
      onLifecycleEvent: (event) => {
        if (event.type === "extension_error") errors.push(event);
      },
    });
    await loader.loadAll();
    const loaded = loader.list()[0];
    const tool = loaded.registries.tools.get("spin")!;
    const started = Date.now();
    await loader.runBounded(
      { extensionId: loaded.id, method: "tool:spin" },
      () => tool.execute("c1", {}),
    );
    assert.ok(Date.now() - started < 1_500, "timeout did not bound the loop");
    assert.ok(
      errors.some((event) => event.error === "handler timed out"),
      JSON.stringify(errors.map((event) => event.error)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .lua suffix selects the runtime that reaches staging and commit", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "seam.lua");
    writeFileSync(fixture, "-- runtime is supplied by the test\n");
    let loads = 0;
    const loader = makeLoader(dir, {
      moduleRuntimes: {
        ".lua": {
          async load() {
            loads++;
            return {
              factory: (api: ExtensionAPI) => {
                api.registerTool({
                  name: "seam",
                  label: "s",
                  description: "d",
                  execute: async () => "ok",
                });
              },
              exports: {},
            };
          },
        },
      },
    });
    await loader.loadAll();
    assert.equal(loader.list()[0].status, "loaded");
    assert.deepEqual([...loader.list()[0].registries.tools.keys()], ["seam"]);
    assert.equal(loader.diagnostics()[0].language, "lua");

    writeFileSync(fixture, "-- replacement\n");
    const staged = await loader.stageExtensions();
    assert.equal(loads, 2);
    assert.deepEqual([...loader.list()[0].registries.tools.keys()], ["seam"]);
    await loader.commitStaged(staged);
    assert.equal(loader.list()[0].registries.tools.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua exec exposes stdout, stderr, and exit code", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "exec.lua");
    const nodePath = process.execPath
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'run', label = 'r', description = 'd',",
        "    execute = function()",
        '      local result = pi.exec("' +
          nodePath +
          "\", { '-e', \"process.stderr.write('err'); process.exit(3)\" })",
        "      return tostring(result.exitCode) .. '|' .. result.stderr",
        "    end",
        "  })",
        "end",
        "test = function(ctx)",
        "  local value = ctx.tools[1].execute('c1', {}):await()",
        "  ctx.assert.equal(value, '3|err')",
        "end",
        "",
      ].join("\n"),
    );
    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled Lua dialog becomes a contained extension error", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "cancel.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'ask', label = 'a', description = 'd',",
        "    execute = function() return pi.ui.select('pick', { 'one' }) end",
        "  })",
        "end",
        "test = function(ctx)",
        "  ctx.holdDialogs(true)",
        "  ctx.cancelDialogsAfterOpen('overlay closed')",
        "  local ok = pcall(function() ctx.tools[1].execute('c1', {}):await() end)",
        "  ctx.assert.equal(ok, false)",
        "  ctx.diagnostic('overlay closed')",
        "end",
        "",
      ].join("\n"),
    );
    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua dialogs and span resolve to their values and are recorded", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "dialogs.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'ask', label = 'a', description = 'd',",
        "    execute = function()",
        "      local s = pi.ui.select('pick', { 'one', 'two' })",
        "      local c = pi.ui.confirm('sure', 'yes')",
        "      local i = pi.ui.input('name', 'default')",
        "      local v = pi.span('lua-span', function() return 7 end)",
        "      return s .. '|' .. tostring(c) .. '|' .. i .. '|' .. tostring(v)",
        "    end",
        "  })",
        "end",
        "test = function(ctx)",
        "  local value = ctx.tools[1].execute('c1', {}):await()",
        "  ctx.assert.equal(value, 'one|true|default|7')",
        "  ctx.assert.equal(ctx.doctor()[1].observability.spanCount, 1)",
        "end",
        "",
      ].join("\n"),
    );

    const result = await runExtensionTest(fixture);
    assert.equal(
      result.passed,
      true,
      result.failures.concat(result.errors).join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua fetch uses the allowlist and strips credentials", async () => {
  const dir = tempDir();
  let seenAuthorization: string | undefined;
  const server = createServer((request, response) => {
    seenAuthorization = request.headers.authorization as string | undefined;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pong");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const pkgDir = join(dir, "networked");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "networked-lua",
        atom: {
          extensions: ["./index.lua"],
          permissions: { network: { hosts: ["127.0.0.1"] } },
        },
      }),
    );
    writeFileSync(
      join(pkgDir, "index.lua"),
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'get', label = 'g', description = 'd',",
        "    execute = function()",
        "      local response = pi.fetch('http://127.0.0.1:" +
          port +
          "/', { headers = { Authorization = 'Bearer secret' } })",
        "      return tostring(response.status) .. '|' .. response:text():await()",
        "    end",
        "  })",
        "  pi.registerTool({ name = 'denied', label = 'd', description = 'd',",
        "    execute = function() return pi.fetch('http://evil.example/').status end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );

    const loader = makeLoader(dir);
    await loader.loadAll();
    const loaded = loader.list()[0];
    assert.equal(loaded.status, "loaded");
    const get = loaded.registries.tools.get("get")!;
    assert.equal(await get.execute("c1", {}), "200|pong");
    assert.equal(seenAuthorization, undefined);

    const denied = loaded.registries.tools.get("denied")!;
    await assert.rejects(
      () =>
        loader.runBounded(
          { extensionId: loaded.id, method: "tool:denied" },
          () => denied.execute("c2", {}),
          { rethrow: true },
        ),
      /network/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scope-denied async Lua call fails with the scope error", async () => {
  const dir = tempDir();
  try {
    const pkgDir = join(dir, "gated");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "gated-lua",
        atom: {
          extensions: ["./index.lua"],
          permissions: { network: { hosts: ["127.0.0.1"] } },
        },
      }),
    );
    writeFileSync(
      join(pkgDir, "index.lua"),
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'run', label = 'r', description = 'd',",
        "    execute = function() return pi.exec('echo', { 'x' }).stdout end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );

    const loader = makeLoader(dir);
    await loader.loadAll();
    const loaded = loader.list()[0];
    assert.equal(loaded.status, "loaded");
    const tool = loaded.registries.tools.get("run")!;
    await assert.rejects(
      () =>
        loader.runBounded(
          { extensionId: loaded.id, method: "tool:run" },
          () => tool.execute("c1", {}),
          { rethrow: true },
        ),
      /exec/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua command handlers receive arguments and rejections are contained", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "commands.lua"),
      [
        "activate = function(pi)",
        "  pi.registerCommand({ name = 'greet', description = 'g',",
        "    run = function(args) __cmdArgs = args end",
        "  })",
        "  pi.registerCommand({ name = 'bad', description = 'b',",
        "    run = function() error('command boom') end",
        "  })",
        "  pi.registerTool({ name = 'last', label = 'l', description = 'd',",
        "    execute = function() return __cmdArgs end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const errors: ExtensionLifecycleEvent[] = [];
    const loader = makeLoader(dir, {
      onLifecycleEvent: (event) => {
        if (event.type === "extension_error") errors.push(event);
      },
    });
    await loader.loadAll();
    const loaded = loader.list()[0];
    const greet = loaded.registries.commands.get("greet")!;
    await loader.runBounded(
      { extensionId: loaded.id, method: "command:/greet" },
      () => greet.run!("hello", loaded.context!),
    );
    const last = loaded.registries.tools.get("last")!;
    assert.equal(await last.execute("c1", {}), "hello");

    const bad = loaded.registries.commands.get("bad")!;
    await loader.runBounded(
      { extensionId: loaded.id, method: "command:/bad" },
      () => bad.run!("x", loaded.context!),
    );
    assert.ok(
      errors.some((event) => (event.error ?? "").includes("command boom")),
      JSON.stringify(errors.map((event) => event.error)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua lifecycle handlers observe siblings after the set is committed", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "provider.lua"), "activate = function(pi) end\n");
    writeFileSync(
      join(dir, "watcher.lua"),
      [
        "__seen = ''",
        "activate = function(pi)",
        "  pi.on('extension_load', function(ev)",
        "    __seen = __seen .. tostring(ev.extensionId) .. ';'",
        "  end)",
        "  pi.registerTool({ name = 'seen', label = 's', description = 'd',",
        "    execute = function() return __seen end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );

    const loader = makeLoader(dir);
    await loader.loadAll();
    const watcher = loader.list().find((entry) => entry.id === "watcher")!;
    const tool = watcher.registries.tools.get("seen")!;
    const seen = (await tool.execute("c1", {})) as string;
    assert.match(seen, /provider;/);
    assert.match(seen, /watcher;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
