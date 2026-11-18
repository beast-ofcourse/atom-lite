// Contract tests for ticket 04 (tool registration gate).
//
// Seams under test:
//   - registerTool (observed through ExtensionLoader lifecycle events): a tool
//     with an invalid name, description, or parameters schema is rejected with
//     an attributable extension_error and never reaches the tool set.
//   - collectExtensionTools/resolveModelTools: colliding names get a
//     deterministic, extension-id-prefixed rename (no last-wins), and hidden
//     tools never reach the model-visible list while codemode/deferred tools do.
//   - coerceToolArguments: non-required null arguments survive coercion.
//   - extensionToolToAgentTool: execute is called with the uniform five-argument
//     signature regardless of declared defaults, and a stale definition hash is
//     rejected with a model-visible error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import {
  collectExtensionTools,
  coerceToolArguments,
  extensionToolToAgentTool,
  resolveModelTools,
} from "../../dist/extensions/tool-adapter.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-tool-gate-"));
}

function writeExtension(dir: string, name: string, body: string): void {
  writeFileSync(
    join(dir, `${name}.js`),
    `export default (api) => { ${body} };\n`,
  );
}

function names(tools: Array<{ definition: { name: string } }>): string[] {
  return tools.map((tool) => tool.definition.name);
}

function extTool(name: string, exposure?: string): Record<string, unknown> {
  return {
    name,
    label: name,
    description: `tool ${name}`,
    ...(exposure ? { exposure } : {}),
    execute: async () => name,
  };
}

function hostTool(name: string): Record<string, unknown> {
  return {
    definition: { name, description: name, parameters: {} },
    execute: async () => ({ content: name }),
  };
}

function toolCtx(): Record<string, unknown> {
  return { signal: new AbortController().signal, onToolOutput: () => {} };
}

test("registerTool rejects invalid tools with an attributable extension_error", async () => {
  const dir = tempDir();
  try {
    writeExtension(
      dir,
      "badtools",
      [
        "api.registerTool({ name: '', label: 'l', description: 'd', execute: async () => 1 });",
        "api.registerTool({ name: 'noDesc', label: 'l', execute: async () => 1 });",
        "api.registerTool({ name: 'badSchema', label: 'b', description: 'd', parameters: { type: 'array' }, execute: async () => 1 });",
        "api.registerTool({ name: 'good', label: 'g', description: 'd', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async () => 1 });",
      ].join("\n"),
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    assert.deepEqual(names(collectExtensionTools(loader)), ["good"]);
    const errors = loader
      .lifecycleEvents()
      .filter((event) => event.type === "extension_error");
    assert.equal(errors.length, 3);
    assert.ok(errors.every((event) => event.extensionId === "badtools"));
    const messages = errors.map((event) => event.error ?? "").join("\n");
    assert.match(messages, /name/);
    assert.match(messages, /description/);
    assert.match(messages, /parameters/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate tool names get a deterministic extension-id-prefixed rename", async () => {
  const dir = tempDir();
  const originalError = console.error;
  const logged: string[] = [];
  try {
    writeExtension(
      dir,
      "alpha",
      `api.registerTool(${JSON.stringify(extTool("shared"))});`,
    );
    writeExtension(
      dir,
      "beta",
      `api.registerTool(${JSON.stringify(extTool("shared"))});`,
    );
    const loader = new ExtensionLoader({
      userDir: dir,
      agentDir: join(dir, "agent"),
    });
    await loader.loadAll();

    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    const first = names(collectExtensionTools(loader)).sort();
    const second = names(collectExtensionTools(loader)).sort();
    console.error = originalError;

    assert.deepEqual(first, ["beta_shared", "shared"]);
    assert.deepEqual(second, first, "renames are stable across resolutions");
    assert.equal(
      new Set(first).size,
      first.length,
      "model-visible names unique",
    );
    assert.ok(
      logged.some(
        (line) => line.includes("shared") && line.includes("beta_shared"),
      ),
      "the rename is reported to the author",
    );
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hidden tools stay out of the model list while codemode and deferred remain", () => {
  const tools = new Map([
    ["direct", extTool("direct", "direct")],
    ["hidden", extTool("hidden", "hidden")],
    ["codemode", extTool("codemode", "codemode")],
    ["deferred", extTool("deferred", "deferred")],
  ]);
  const loader = {
    list: () => [{ status: "loaded", id: "ext", registries: { tools } }],
  };

  assert.deepEqual(names(collectExtensionTools(loader)), [
    "direct",
    "codemode",
    "deferred",
  ]);
  assert.deepEqual(
    names(
      resolveModelTools({
        builtInTools: [hostTool("builtin")],
        loader,
        mcpTools: [hostTool("mcp")],
      }) as Array<{ definition: { name: string } }>,
    ),
    ["builtin", "direct", "codemode", "deferred", "mcp"],
  );
  assert.ok(
    tools.has("hidden"),
    "hidden tools remain callable via the registry",
  );
});

test("non-required null arguments are preserved instead of deleted", () => {
  const schema = {
    type: "object",
    properties: { note: { type: "string" }, count: { type: "number" } },
    required: ["count"],
  };
  assert.deepEqual(coerceToolArguments(schema, { note: null, count: "3" }), {
    note: null,
    count: 3,
  });
});

test("execute receives all five arguments even when defaults reduce its length", async () => {
  const tool = extensionToolToAgentTool(
    {
      name: "sig",
      label: "s",
      description: "d",
      execute: async function (
        id: unknown,
        params: unknown,
        signal: unknown,
        onUpdate: unknown = () => {},
        ctx: any = {},
      ) {
        return {
          id,
          params,
          marked: ctx.marker,
          signalPresent: !!signal,
          updateType: typeof onUpdate,
        };
      },
    },
    { marker: "ctx" } as any,
  );

  const result = await tool.execute(
    { id: "call-1", name: "sig", arguments: { n: 1 } } as any,
    toolCtx() as any,
  );
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), {
    id: "call-1",
    params: { n: 1 },
    marked: "ctx",
    signalPresent: true,
    updateType: "function",
  });
});

test("a stale definition hash is rejected with a model-visible error", async () => {
  const tool = extensionToolToAgentTool(
    {
      name: "hashed",
      label: "h",
      description: "d",
      parameters: {
        type: "object",
        properties: { n: { type: "number" } },
      },
      execute: async () => "ok",
    },
    {} as any,
  );
  const parameters = tool.definition.parameters as {
    properties: Record<string, { enum?: string[] }>;
  };
  const hash = parameters.properties.__atomToolHash?.enum?.[0];
  assert.ok(hash, "the model-visible definition carries a definition hash");

  const fresh = await tool.execute(
    {
      id: "1",
      name: "hashed",
      arguments: { __atomToolHash: hash, n: 1 },
    } as any,
    toolCtx() as any,
  );
  assert.notEqual(fresh.isError, true);
  assert.equal(fresh.content, "ok");

  const stale = await tool.execute(
    {
      id: "2",
      name: "hashed",
      arguments: { __atomToolHash: "stale", n: 1 },
    } as any,
    toolCtx() as any,
  );
  assert.equal(stale.isError, true);
  assert.match(stale.content, /changed|stale|definition/i);
});
