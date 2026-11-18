// Contract tests for ticket 03 (single source tool set).
//
// Seams under test:
//   - collectExtensionTools(): the model-visible set is derived from live
//     loader registries at point of use, and honors setActiveTools.
//   - resolveModelTools(): composes built-in + extension + MCP tools fresh on
//     every call (no cached snapshot), and suppresses all tools under
//     --no-tools.
//
// Each test names the failure it pins: a tool mutation or reload that is not
// reflected on the next resolution, or extension tools leaking through
// --no-tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionLoader } from "../../dist/extensions/loader.js";
import { collectExtensionTools } from "../../dist/extensions/tool-adapter.js";
import * as adapter from "../../dist/extensions/tool-adapter.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { InMemorySession } from "../../dist/sessions/store.js";

const resolveModelTools = (adapter as any).resolveModelTools as (
  options: Record<string, unknown>,
) => Array<{ definition: { name: string } }>;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atom-lite-single-source-"));
}

function makeLoader(dir: string): ExtensionLoader {
  return new ExtensionLoader({ userDir: dir, agentDir: join(dir, "agent") });
}

function writeExtension(dir: string, name: string, body: string): void {
  writeFileSync(
    join(dir, `${name}.js`),
    `export default (api) => { ${body} };\n`,
  );
}

function extTool(name: string): Record<string, unknown> {
  return {
    name,
    label: name,
    description: `tool ${name}`,
    execute: async () => name,
  };
}

function hostTool(name: string): Record<string, unknown> {
  return {
    definition: { name, description: name, parameters: {} },
    execute: async () => ({ content: name }),
  };
}

function names(tools: Array<{ definition: { name: string } }>): string[] {
  return tools.map((tool) => tool.definition.name);
}

test("registerTool and unregisterTool are visible on the next resolution", async () => {
  const dir = tempDir();
  try {
    writeExtension(
      dir,
      "mutable",
      [
        "globalThis.__t03MutableApi = api;",
        `api.registerTool(${JSON.stringify(extTool("initial"))});`,
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const current = () => names(collectExtensionTools(loader));

    assert.deepEqual(current(), ["initial"]);

    const api = (globalThis as any).__t03MutableApi;
    assert.ok(api, "activation exposed the api to the fixture");
    api.registerTool(extTool("added"));
    assert.deepEqual(current(), ["initial", "added"]);

    api.unregisterTool("initial");
    assert.deepEqual(current(), ["added"]);
  } finally {
    delete (globalThis as any).__t03MutableApi;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setActiveTools narrows the model-visible set on the next resolution", async () => {
  const dir = tempDir();
  try {
    writeExtension(
      dir,
      "scope",
      [
        "globalThis.__t03ScopeApi = api;",
        `api.registerTool(${JSON.stringify(extTool("a"))});`,
        `api.registerTool(${JSON.stringify(extTool("b"))});`,
      ].join("\n"),
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const current = () => names(collectExtensionTools(loader));

    assert.deepEqual(current(), ["a", "b"]);

    const api = (globalThis as any).__t03ScopeApi;
    api.setActiveTools(["b"]);
    assert.deepEqual(current(), ["b"]);

    api.setActiveTools(["a"]);
    assert.deepEqual(current(), ["a"]);
  } finally {
    delete (globalThis as any).__t03ScopeApi;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload then MCP change resolves current loader state, not a startup snapshot", async () => {
  const dir = tempDir();
  try {
    writeExtension(
      dir,
      "reloadable",
      `api.registerTool(${JSON.stringify(extTool("old"))});`,
    );
    const loader = makeLoader(dir);
    await loader.loadAll();
    const builtin = hostTool("builtin");
    const mcp = hostTool("mcp");
    const resolve = () =>
      resolveModelTools({
        builtInTools: [builtin],
        loader,
        mcpTools: [mcp],
        useTools: true,
      });

    assert.deepEqual(names(resolve()), ["builtin", "old", "mcp"]);

    // A reload replaces the loader's state with a different tool set.
    writeExtension(
      dir,
      "reloadable",
      `api.registerTool(${JSON.stringify(extTool("new"))});`,
    );
    await loader.loadAll();

    // An MCP list change triggers another resolution; it must not restore the
    // startup snapshot.
    assert.deepEqual(names(resolve()), ["builtin", "new", "mcp"]);
    assert.ok(
      !names(resolve()).includes("old"),
      "the removed tool must stay absent",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-tools yields an empty tool list even with tools available", () => {
  const ext = extTool("ext");
  const loader = {
    list: () => [
      {
        status: "loaded",
        registries: { tools: new Map([[ext.name, ext]]) },
      },
    ],
  };
  const options = {
    builtInTools: [hostTool("builtin")],
    loader,
    mcpTools: [hostTool("mcp")],
    useTools: false,
  };
  assert.deepEqual(resolveModelTools(options), []);

  assert.deepEqual(
    names(resolveModelTools({ ...options, useTools: true })),
    ["builtin", "ext", "mcp"],
    "control: the same tools are visible when --no-tools is absent",
  );
});

test("AgentRuntime.setTools swaps the tool set without changing provider or model", async () => {
  const dir = tempDir();
  try {
    const provider: any = {
      id: "recording",
      model: "pinned-model",
      requests: [] as any[],
      async generate(request: any) {
        this.requests.push(request);
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          toolCalls: [],
          finishReason: "stop",
          usage: { input: 1, output: 1 },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      workspace: dir,
      tools: [hostTool("old")],
    });
    const session = new InMemorySession("s1", dir);
    const signal = new AbortController().signal;

    await runtime.runAgentTurn("first", session, signal);
    const first = provider.requests.at(-1);
    assert.deepEqual(
      first.tools.map((tool: any) => tool.name),
      ["old"],
    );
    assert.equal(first.model, "pinned-model");

    // The host hands setTools a freshly resolved list on the next turn.
    runtime.setTools(
      resolveModelTools({ builtInTools: [hostTool("new")], useTools: true }),
    );
    await runtime.runAgentTurn("second", session, signal);
    const second = provider.requests.at(-1);
    assert.deepEqual(
      second.tools.map((tool: any) => tool.name),
      ["new"],
    );
    assert.equal(second.model, first.model);
    assert.equal(provider.requests.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
