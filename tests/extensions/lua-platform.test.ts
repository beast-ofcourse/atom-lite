import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { describeScopes } from "../../dist/extensions/manifest.js";
import { discoverExtensions } from "../../dist/extensions/discovery.js";
import { resolveModelTools } from "../../dist/extensions/tool-adapter.js";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
import { ProjectTrustPrompt } from "../../dist/cli/trust-prompt.js";
import { runExtensionTest } from "../../dist/extensions/harness.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-lua-platform-"));
}

function makeLoader(
  dir: string,
  options: ConstructorParameters<typeof ExtensionLoader>[0] = {},
): ExtensionLoader {
  return new ExtensionLoader({
    userDir: dir,
    agentDir: join(dir, "agent"),
    ...options,
  });
}

async function callTool(
  loader: ExtensionLoader,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = resolveModelTools({ loader, useTools: true }).find(
    (candidate) => candidate.definition.name === name,
  );
  assert.ok(tool, `missing tool ${name}`);
  const result = (await tool.execute(
    { id: "c1", name, arguments: args } as never,
    { workspace: process.cwd(), signal: new AbortController().signal } as never,
  )) as { content: string };
  return result.content;
}

function extensionErrors(loader: ExtensionLoader) {
  return loader
    .lifecycleEvents()
    .filter((event) => event.type === "extension_error");
}

function writePackage(
  dir: string,
  name: string,
  entry: string,
  permissions?: Record<string, unknown>,
): void {
  const packageDir = join(dir, name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "index.lua"), entry);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name,
      atom: {
        extensions: ["./index.lua"],
        ...(permissions ? { permissions } : {}),
      },
    }),
  );
}

test("Lua wrapTool intercepts a JavaScript tool and replaces its result", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "js-tool.js"),
      [
        "export default (api) => {",
        "  api.registerTool({",
        "    name: 'target', label: 't', description: 'd',",
        "    execute: async () => ({ content: 'base' }),",
        "  });",
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "lua-wrap.lua"),
      [
        "activate = function(pi)",
        "  pi.wrapTool('target', function(call, next)",
        "    local result = next():await()",
        "    return { content = 'replaced:' .. tostring(result.content) }",
        "  end)",
        "end",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const result = await callTool(loader, "target");
    assert.match(result, /^replaced:/);
    assert.match(result, /base/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua and JavaScript services resolve in provider order", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "a-consumer.lua"),
      [
        "activate = function(pi)",
        "  local greeter = pi.consume('greeter', '^1.0.0')",
        "  pi.registerTool({ name = 'use', label = 'u', description = 'd',",
        "    execute = function() return greeter.greet('Ada') end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "z-provider.js"),
      [
        "export default (api) => api.provide('greeter', { greet: (name) => 'hi ' + name }, '1.2.0');",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const ids = loader.list().map((entry) => entry.id);
    assert.ok(
      ids.indexOf("z-provider") < ids.indexOf("a-consumer"),
      JSON.stringify(ids),
    );
    assert.equal(await callTool(loader, "use"), "hi Ada");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua service errors are typed and attributed in doctor", async () => {
  const cases: Array<{
    label: string;
    provider?: string;
    consumer: string;
    expected: RegExp;
    method: string;
  }> = [
    {
      label: "missing",
      consumer: "activate = function(pi) pi.consume('absent', '*') end\n",
      expected: /absent/,
      method: "consume",
    },
    {
      label: "incompatible",
      provider: "export default (api) => api.provide('svc', {}, '1.0.0');\n",
      consumer: "activate = function(pi) pi.consume('svc', '^2.0.0') end\n",
      expected: /svc/,
      method: "consume",
    },
    {
      label: "duplicate",
      provider:
        "export default (api) => { api.provide('same', {}, '1.0.0'); api.provide('same', {}, '2.0.0'); };\n",
      consumer: "activate = function(pi) end\n",
      expected: /already provided/,
      method: "provide",
    },
    {
      label: "cycle",
      provider:
        "export default (api) => { api.provide('b', {}, '1.0.0'); api.consume('a', '*'); };\n",
      consumer: [
        "activate = function(pi)",
        "  pi.provide('a', {}, '1.0.0')",
        "  pi.consume('b', '*')",
        "end",
        "",
      ].join("\n"),
      expected: /cycle/,
      method: "consume",
    },
  ];
  for (const item of cases) {
    const dir = tempDir();
    try {
      if (item.provider) {
        writeFileSync(join(dir, "provider.js"), item.provider);
      }
      writeFileSync(join(dir, "consumer.lua"), item.consumer);
      const loader = makeLoader(dir);
      await loader.loadAll();
      const errors = extensionErrors(loader);
      assert.ok(errors.length > 0, `${item.label}: no failure recorded`);
      assert.match(errors[0].error ?? "", item.expected);
      assert.match(loader.doctor(), new RegExp(item.method));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Lua middleware and services are cleared by unload and reload", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "cooperate.lua");
    const withService = [
      "activate = function(pi)",
      "  pi.provide('counter', { value = 1 }, '1.0.0')",
      "  pi.wrapTool('self', function(call, next)",
      "    return { content = 'wrapped' }",
      "  end)",
      "  pi.registerTool({ name = 'self', label = 's', description = 'd',",
      "    execute = function() return 'base' end",
      "  })",
      "end",
      "",
    ].join("\n");
    writeFileSync(fixture, withService);
    const loader = makeLoader(dir);
    await loader.loadAll();
    assert.deepEqual(loader.listServices(), ["counter"]);
    assert.equal(await callTool(loader, "self"), "wrapped");

    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'self', label = 's', description = 'd',",
        "    execute = function() return 'base' end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const staged = await loader.stageExtensions();
    await loader.commitStaged(staged);
    assert.deepEqual(loader.listServices(), []);
    assert.equal(await callTool(loader, "self"), "base");

    await loader.unloadAll();
    assert.equal(loader.list().length, 0);
    assert.deepEqual(loader.listServices(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua manifest scopes gate denied calls and the trust prompt lists them", async () => {
  const dir = tempDir();
  try {
    writePackage(
      dir,
      "scoped",
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'probe', label = 'p', description = 'd',",
        "    execute = function() return pi.exec('echo', { 'x' }).stdout end",
        "  })",
        "end",
        "",
      ].join("\n"),
      { network: { hosts: ["127.0.0.1"] } },
    );
    writeFileSync(join(dir, "legacy.lua"), "activate = function(pi) end\n");
    const loader = makeLoader(dir);
    await loader.loadAll();
    const doctor = JSON.parse(loader.doctorJson());
    const entry = doctor.find((item: { id: string }) => item.id === "scoped");
    assert.equal(entry.language, "lua");
    assert.equal(entry.scopeMode, "scoped");
    assert.deepEqual(entry.scopes, ["network: hosts [127.0.0.1]"]);
    const legacy = doctor.find((item: { id: string }) => item.id === "legacy");
    assert.equal(legacy.scopeMode, "legacy-unscoped");
    assert.equal(legacy.status, "loaded");

    const discovered = discoverExtensions({ userDir: dir });
    const prompt = new ProjectTrustPrompt(
      discovered.map((item) => ({
        id: item.id,
        entryPath: item.entryPath,
        scopes: describeScopes(item.manifest?.scopes),
      })),
      dir,
      () => {},
    );
    assert.match(
      prompt.render(200).join("\n"),
      /network: hosts \[127\.0\.0\.1\]/,
    );

    const loaded = loader.list()[0];
    const tool = loaded.registries.tools.get("probe")!;
    await assert.rejects(
      () =>
        loader.runBounded(
          { extensionId: loaded.id, method: "tool:probe" },
          () => tool.execute("c1", {}),
          { rethrow: true },
        ),
      /exec/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua denied UI, provider, and session calls name their scope", async () => {
  const dir = tempDir();
  try {
    writePackage(
      dir,
      "closed",
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'denied', label = 'd', description = 'd',",
        "    execute = function()",
        "      local results = {}",
        "      local calls = {",
        "        function() pi.registerProvider('p', {}) end,",
        "        function() pi.fetch('http://evil.example/') end,",
        "        function() pi.ui.notify('no', 'info') end,",
        "        function() pi.appendEntry('note', { v = 1 }) end,",
        "      }",
        "      for _, call in ipairs(calls) do",
        "        local ok, err = pcall(call)",
        "        table.insert(results, tostring(err))",
        "      end",
        "      return table.concat(results, '|')",
        "    end",
        "  })",
        "end",
        "",
      ].join("\n"),
      { network: {} },
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const result = await callTool(loader, "denied");
    assert.match(result, /providers/);
    assert.match(result, /network/);
    assert.match(result, /ui/);
    assert.match(result, /session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua store migration persists and an oversized write leaves state unchanged", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "store.lua"),
      [
        "activate = function(pi)",
        "  pi.store.version = 2",
        "  pi.store.migrate = function(oldVersion, value)",
        "    return { count = (value.count or 0) + 1 }",
        "  end",
        "  pi.store.set('count', (pi.store.get('count') or 0) + 10)",
        "  pi.store.set('gone', true)",
        "  pi.store.delete('gone')",
        "  pi.registerTool({ name = 'probe', label = 'p', description = 'd',",
        "    execute = function()",
        "      local ok = pcall(pi.store.set, 'big', string.rep('x', 1024 * 1024))",
        "      return tostring(ok) .. '|' .. tostring(pi.store.get('count')) .. '|' .. tostring(pi.store.version) .. '|' .. tostring(pi.store.get('gone') or 'missing')",
        "    end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const stateDir = join(dir, "agent", "extension-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "store.json"),
      JSON.stringify({ version: 1, value: { count: 1 } }),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const result = await callTool(loader, "probe");
    assert.match(result, /^false\|12\|2\|missing$/);
    const persisted = JSON.parse(
      readFileSync(join(stateDir, "store.json"), "utf8"),
    );
    assert.equal(persisted.value.count, 12);
    assert.equal(persisted.value.big, undefined);

    await loader.unloadAll();
    assert.ok(
      existsSync(join(dir, "agent", "extension-state", "store.json.bak")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua session entries survive a reload through the live session", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "sessions.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.appendEntry('note', { v = 7 })",
        "  pi.registerTool({ name = 'read', label = 'r', description = 'd',",
        "    execute = function() return 'v1' end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const store = new JsonlSessionStore({ rootDir: join(dir, "sessions") });
    const session = store.create({
      workspace: dir,
      provider: "fake",
      id: "s-lua",
    });
    const loader = makeLoader(dir, { session });
    await loader.loadAll();
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'read', label = 'r', description = 'd',",
        "    execute = function()",
        "      local entries = pi.getSessionEntries()",
        "      return tostring(#entries) .. '|' .. tostring(pi.getSessionManager():getId())",
        "    end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const staged = await loader.stageExtensions();
    await loader.commitStaged(staged);
    assert.equal(await callTool(loader, "read"), "1|s-lua");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua syntax and missing factory failures leave no registrations live", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "broken.lua"), "activate = function(pi)\n");
    writeFileSync(join(dir, "no-factory.lua"), "local nothing = 1\n");
    const loader = makeLoader(dir);
    await loader.loadAll();
    const byId = new Map(loader.list().map((entry) => [entry.id, entry]));
    for (const id of ["broken", "no-factory"]) {
      const entry = byId.get(id)!;
      assert.equal(entry.status, "error");
      assert.ok(entry.error && entry.error.length > 0);
      assert.equal(entry.registries.tools.size, 0);
    }
    assert.match(byId.get("no-factory")!.error ?? "", /activate/);
    assert.match(loader.doctor(), /broken/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lua middleware and async failures are attributed without stopping later tools", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "faults.lua"),
      [
        "activate = function(pi)",
        "  pi.wrapTool('target', function(call, next) error('middleware boom') end)",
        "  pi.registerTool({ name = 'target', label = 't', description = 'd',",
        "    execute = function() return 'base' end",
        "  })",
        "  pi.registerTool({ name = 'healthy', label = 'h', description = 'd',",
        "    execute = function() return 'ok' end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    await assert.rejects(() => callTool(loader, "target"), /middleware boom/);
    assert.equal(await callTool(loader, "healthy"), "ok");

    const errors = extensionErrors(loader);
    assert.ok(
      errors.some((event) => (event.error ?? "").includes("middleware boom")),
      JSON.stringify(errors.map((event) => event.error)),
    );
    const doctor = loader.doctor();
    assert.match(doctor, /wrapTool:target/);
    assert.match(doctor, /reject/);
    assert.match(doctor, /lua-callback|middleware boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed Lua reload keeps the live set and stale callbacks are skipped", async () => {
  const dir = tempDir();
  try {
    const fixture = join(dir, "reload.lua");
    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.on('session_start', function() end)",
        "  pi.registerTool({ name = 'old', label = 'o', description = 'd',",
        "    execute = function() return 'old' end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const errors: string[] = [];
    const loader = makeLoader(dir, {
      onLifecycleEvent: (event) => {
        if (event.type === "extension_error") errors.push(event.error ?? "");
      },
    });
    await loader.loadAll();
    const first = loader.list()[0];
    const oldHandler = [
      ...(first.registries.handlers.get("session_start") ?? []),
    ][0] as ((payload: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    assert.ok(oldHandler, "old handler was registered");

    const discover = (loader as unknown as { discover: () => unknown })
      .discover;
    (loader as unknown as { discover: () => unknown }).discover = () => {
      throw new Error("reload exploded");
    };
    let caught: unknown;
    try {
      await loader.stageExtensions();
    } catch (error) {
      caught = error;
    } finally {
      (loader as unknown as { discover: () => unknown }).discover = discover;
    }
    assert.match(String(caught), /reload exploded/);
    assert.equal(await callTool(loader, "old"), "old");
    assert.equal(loader.list()[0], first);

    writeFileSync(
      fixture,
      [
        "activate = function(pi)",
        "  pi.registerTool({ name = 'new', label = 'n', description = 'd',",
        "    execute = function() return 'new' end",
        "  })",
        "end",
        "",
      ].join("\n"),
    );
    const staged = await loader.stageExtensions();
    await loader.commitStaged(staged);
    await oldHandler({}, first.context);
    assert.ok(
      errors.some((message) => message.includes("stale generation")),
      JSON.stringify(errors),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("published Lua fault-injection fixtures produce attributable errors", async () => {
  const fixtures = [
    "activation-throw.lua",
    "tool-throw.lua",
    "event-throw.lua",
    "dialog-teardown.lua",
  ];
  const root = join(import.meta.dirname, "..", "fixtures", "extensions");
  for (const fixture of fixtures) {
    const result = await runExtensionTest(join(root, fixture));
    assert.equal(
      result.passed,
      true,
      `${fixture}: ${result.failures.join("; ")} ${result.errors.join("; ")}`,
    );
    assert.ok(result.assertions > 0, `${fixture}: assertions ran`);
  }
});
