// Contract tests for ticket 13 (tool middleware and inter-extension services).
//
// Seams under test:
//   - resolveModelTools()/collectExtensionTools(): a wrapped tool is composed
//     around its execute in registration order, and a wrapped hidden tool stays
//     out of the model-visible set.
//   - ExtensionLoader.loadAll()/unloadAll() + pi.provide()/pi.consume():
//     services resolve across extensions in dependency order, typed errors are
//     raised for missing/incompatible/cyclic services, and middleware and
//     services are removed on unload and reload.
//
// Each test names the failure it pins: two extensions must cooperate on one
// tool and one typed service without module-level side effects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { resolveModelTools } from "../../dist/extensions/tool-adapter.js";
import type { Tool } from "../../dist/tools/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-t13-"));
}

function makeLoader(dir: string): ExtensionLoader {
  return new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
}

function callTool(tool: Tool, args: Record<string, unknown> = {}) {
  const ctx = {
    workspace: process.cwd(),
    signal: new AbortController().signal,
  } as any;
  return tool.execute(
    { id: "c1", name: tool.definition.name, arguments: args } as any,
    ctx,
  );
}

function findTool(loader: ExtensionLoader, name: string): Tool | undefined {
  return resolveModelTools({ loader, useTools: true }).find(
    (tool) => tool.definition.name === name,
  );
}

test("wrapTool composes in registration order: first registered is outermost and runs first", async () => {
  const dir = tempDir();
  (globalThis as any).__t13Order = [];
  try {
    writeFileSync(
      join(dir, "a.js"),
      [
        "export default (api) => {",
        '  api.registerTool({ name: "target", label: "t", description: "d", execute: async () => "base" });',
        '  api.wrapTool("target", async (call, next) => {',
        "    globalThis.__t13Order.push('A');",
        "    const r = await next();",
        "    return { ...r, content: r.content + 'A' };",
        "  });",
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "b.js"),
      [
        "export default (api) => {",
        '  api.wrapTool("target", async (call, next) => {',
        "    globalThis.__t13Order.push('B');",
        "    const r = await next();",
        "    return { ...r, content: r.content + 'B' };",
        "  });",
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    const tool = findTool(loader, "target");
    assert.ok(tool, "wrapped tool is model-visible");
    const result = await callTool(tool);
    assert.equal(
      result.content,
      "baseBA",
      "inner result passes outward in order",
    );
    assert.deepEqual(
      (globalThis as any).__t13Order,
      ["A", "B"],
      "first registered wrapper runs first",
    );
  } finally {
    delete (globalThis as any).__t13Order;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapTool redacts tool output before it reaches the model", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "redactor.js"),
      [
        "export default (api) => {",
        '  api.registerTool({ name: "secret", label: "s", description: "d", execute: async () => "token=abc123" });',
        '  api.wrapTool("secret", async (call, next) => {',
        "    const r = await next();",
        '    return { ...r, content: r.content.includes("token=") ? "[REDACTED]" : r.content };',
        "  });",
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    const tool = findTool(loader, "secret");
    assert.ok(tool);
    assert.equal(
      (await callTool(tool)).content,
      "[REDACTED]",
      "the wrapper replaces the underlying result",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrapped hidden tool stays out of the model-visible set", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "hider.js"),
      [
        "export default (api) => {",
        '  api.registerTool({ name: "ghost", label: "g", description: "d", exposure: "hidden", execute: async () => "boo" });',
        '  api.wrapTool("ghost", async (call, next) => ({ ...(await next()), content: "seen" }));',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    assert.equal(
      findTool(loader, "ghost"),
      undefined,
      "wrapping does not override exposure: hidden",
    );
    assert.ok(
      loader.list()[0].registries.tools.has("ghost"),
      "the hidden tool stays in its registry for internal callers",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consume resolves a service across two extensions in dependency order", async () => {
  const dir = tempDir();
  try {
    // Alphabetically the consumer loads first; only dependency ordering makes
    // the provider's service available when the consumer activates.
    writeFileSync(
      join(dir, "a-consumer.js"),
      [
        "export default (api) => {",
        '  const greeter = api.consume("greeter", "^1.0.0");',
        '  api.registerTool({ name: "use_greeter", label: "u", description: "d", execute: async () => greeter.greet("Ada") });',
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "z-provider.js"),
      [
        "export default (api) => {",
        '  api.provide("greeter", { greet: (name) => "hi " + name }, "1.2.0");',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    const loaded = await loader.loadAll();

    assert.deepEqual(
      loaded.map((entry) => [entry.id, entry.status]),
      [
        ["z-provider", "loaded"],
        ["a-consumer", "loaded"],
      ],
      "the provider activates before its consumer",
    );
    const tool = findTool(loader, "use_greeter");
    assert.ok(tool);
    assert.equal((await callTool(tool)).content, "hi Ada");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing and version-incompatible services raise ExtensionCompatibilityError", async () => {
  for (const scenario of ["missing", "incompatible"] as const) {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, "a-consumer.js"),
        [
          "export default (api) => {",
          '  api.consume("greeter", "^1.0.0");',
          "};",
          "",
        ].join("\n"),
      );
      if (scenario === "incompatible") {
        writeFileSync(
          join(dir, "z-provider.js"),
          'export default (api) => { api.provide("greeter", {}, "2.0.0"); };\n',
        );
      }
      const loader = makeLoader(dir);
      await loader.loadAll();

      const failure = loader.list().find((entry) => entry.id === "a-consumer");
      assert.equal(failure?.status, "error", `${scenario}: consumer failed`);
      assert.match(
        failure?.error ?? "",
        /ExtensionCompatibilityError/,
        `${scenario}: error is typed`,
      );
      const event = loader
        .lifecycleEvents()
        .find(
          (item) =>
            item.extensionId === "a-consumer" &&
            item.type === "extension_error",
        );
      assert.equal(event?.method, "consume");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cyclic service dependencies are reported with a typed error", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "a.js"),
      [
        "export default (api) => {",
        '  api.provide("a-svc", {}, "1.0.0");',
        '  api.consume("b-svc", "^1.0.0");',
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "b.js"),
      [
        "export default (api) => {",
        '  api.provide("b-svc", {}, "1.0.0");',
        '  api.consume("a-svc", "^1.0.0");',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    const loaded = await loader.loadAll();
    const messages = loaded
      .filter((entry) => entry.status !== "loaded")
      .map((entry) => entry.error ?? "")
      .join(" ");
    assert.match(messages, /ExtensionCompatibilityError/);
    assert.match(messages, /cycle/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unload and reload remove middleware and services with their extension set", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "a-provider.js"),
      [
        "export default (api) => {",
        '  api.provide("greeter", { greet: () => "served" }, "1.0.0");',
        '  api.registerTool({ name: "wrapme", label: "w", description: "d", execute: async () => "base" });',
        '  api.wrapTool("wrapme", async (call, next) => { const r = await next(); return { ...r, content: r.content + "W" }; });',
        "};",
        "",
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();

    assert.deepEqual(loader.listServices(), ["greeter"]);
    const wrapped = findTool(loader, "wrapme");
    assert.ok(wrapped);
    assert.equal((await callTool(wrapped)).content, "baseW");

    await loader.unloadAll();
    assert.deepEqual(loader.listServices(), [], "unload clears services");
    assert.equal(findTool(loader, "wrapme"), undefined);
    assert.equal(
      loader.list().length,
      0,
      "unload clears middleware with the extension set",
    );

    // A reload with a fresh set must not inherit the old service or wrapper.
    rmSync(join(dir, "a-provider.js"));
    writeFileSync(
      join(dir, "fresh.js"),
      'export default (api) => { api.registerTool({ name: "fresh", label: "f", description: "d", execute: async () => "clean" }); };\n',
    );
    await loader.loadAll();
    assert.deepEqual(
      loader.listServices(),
      [],
      "reload publishes no stale service",
    );
    const fresh = findTool(loader, "fresh");
    assert.ok(fresh);
    assert.equal((await callTool(fresh)).content, "clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
