// ToolExecutor: plan-mode gating, lock classification, cancellation, and
// error mapping. Uses fake tools so no filesystem or model is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolExecutor } from "../../dist/runtime/tool-executor.js";
import type { Tool, ToolContext, ToolResult } from "../../dist/tools/types.js";
import type { ToolCall } from "../../dist/types.js";

function fakeTool(
  name: string,
  opts: {
    annotations?: Record<string, unknown>;
    run?: () => Promise<ToolResult> | ToolResult;
  } = {},
): Tool {
  return {
    definition: { name, description: name, parameters: {} },
    annotations: opts.annotations,
    execute: async (call: ToolCall): Promise<ToolResult> =>
      opts.run
        ? opts.run()
        : {
            toolCallId: call.id,
            name,
            content: `${name} ok`,
          },
  };
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}-${Math.random()}`, name, arguments: args };
}

function runCtx(
  toolMap: Map<string, Tool>,
  overrides: Partial<ToolContext> = {},
): ToolContext & { toolMap: Map<string, Tool> } {
  return {
    workspace: "/tmp/atom-lite-executor-test",
    signal: new AbortController().signal,
    mode: "yolo",
    toolMap,
    ...overrides,
  };
}

test("executes every call and maps results by index", async () => {
  const toolMap = new Map<string, Tool>([
    ["read", fakeTool("read", { annotations: { readOnlyHint: true } })],
    ["write", fakeTool("write")],
  ]);
  const results = await new ToolExecutor().run(
    [call("read", { path: "a.txt" }), call("write", { path: "a.txt" })],
    runCtx(toolMap),
    new AbortController().signal,
  );
  assert.equal(results.length, 2);
  assert.match(results[0].content, /read ok/);
  assert.match(results[1].content, /write ok/);
});

test("plan mode blocks the mutating built-ins", async () => {
  const toolMap = new Map<string, Tool>([
    ["write", fakeTool("write")],
    ["edit", fakeTool("edit")],
    ["bash", fakeTool("bash")],
    ["read", fakeTool("read", { annotations: { readOnlyHint: true } })],
  ]);
  const results = await new ToolExecutor().run(
    [
      call("write", { path: "a" }),
      call("edit", { path: "a" }),
      call("bash", { command: "ls" }),
      call("read", { path: "a" }),
    ],
    runCtx(toolMap, { mode: "plan" }),
    new AbortController().signal,
  );
  for (const r of results.slice(0, 3)) {
    assert.equal(r.content, "plan mode: tool disabled");
    assert.equal(r.isError, true);
  }
  assert.match(results[3].content, /read ok/);
});

test("plan mode blocks mutating MCP and extension tools", async () => {
  const toolMap = new Map<string, Tool>([
    // MCP tool with no annotations: treated as mutating, blocked in plan.
    ["mcp__deploy", fakeTool("mcp__deploy")],
    // Extension tool without annotations: blocked.
    ["ext_write", fakeTool("ext_write")],
    // Read-only annotated MCP tool is allowed.
    [
      "mcp__docs_search",
      fakeTool("mcp__docs_search", { annotations: { readOnlyHint: true } }),
    ],
  ]);
  const results = await new ToolExecutor().run(
    [call("mcp__deploy"), call("ext_write"), call("mcp__docs_search")],
    runCtx(toolMap, { mode: "plan" }),
    new AbortController().signal,
  );
  assert.equal(results[0].content, "plan mode: tool disabled");
  assert.equal(results[1].content, "plan mode: tool disabled");
  assert.match(results[2].content, /mcp__docs_search ok/);
});

test("unknown tool reports TOOL_NOT_FOUND", async () => {
  const results = await new ToolExecutor().run(
    [call("ghost", {})],
    runCtx(new Map()),
    new AbortController().signal,
  );
  assert.match(results[0].content, /TOOL_NOT_FOUND: ghost/);
  assert.equal(results[0].isError, true);
});

test("tool exception becomes COMMAND_FAILED, not a crash", async () => {
  const toolMap = new Map<string, Tool>([
    [
      "explode",
      fakeTool("explode", {
        run: async () => {
          throw new Error("boom");
        },
      }),
    ],
  ]);
  const results = await new ToolExecutor().run(
    [call("explode")],
    runCtx(toolMap),
    new AbortController().signal,
  );
  assert.match(results[0].content, /COMMAND_FAILED: boom/);
  assert.equal(results[0].isError, true);
});

test("aborted signal reports USER_CANCELLED without running tools", async () => {
  let ran = 0;
  const toolMap = new Map<string, Tool>([
    [
      "read",
      fakeTool("read", {
        annotations: { readOnlyHint: true },
        run: () => {
          ran++;
          return { toolCallId: "x", name: "read", content: "ran" };
        },
      }),
    ],
  ]);
  const controller = new AbortController();
  controller.abort();
  const results = await new ToolExecutor().run(
    [call("read", { path: "a" })],
    runCtx(toolMap, { signal: controller.signal }),
    controller.signal,
  );
  assert.equal(results[0].content, "USER_CANCELLED");
  assert.equal(ran, 0);
});

test("reads against the same path are not serialized on a write lock", async () => {
  // Two slow reads of the same file should overlap because `read` carries
  // readOnlyHint (regression: unannotated reads used to take a write lock).
  let running = 0;
  let maxConcurrent = 0;
  const toolMap = new Map<string, Tool>([
    [
      "read",
      fakeTool("read", {
        annotations: { readOnlyHint: true },
        run: async () => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 50));
          running--;
          return { toolCallId: "x", name: "read", content: "ok" };
        },
      }),
    ],
  ]);
  const results = await new ToolExecutor().run(
    [call("read", { path: "same.txt" }), call("read", { path: "same.txt" })],
    runCtx(toolMap),
    new AbortController().signal,
  );
  assert.equal(results.length, 2);
  assert.equal(maxConcurrent, 2, "reads ran concurrently");
});

test("writes against the same path serialize", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const toolMap = new Map<string, Tool>([
    [
      "write",
      fakeTool("write", {
        run: async () => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 40));
          running--;
          return { toolCallId: "x", name: "write", content: "ok" };
        },
      }),
    ],
  ]);
  await new ToolExecutor().run(
    [call("write", { path: "f.txt" }), call("write", { path: "f.txt" })],
    runCtx(toolMap),
    new AbortController().signal,
  );
  assert.equal(maxConcurrent, 1, "writes serialized");
});

test("maxParallelToolCalls caps concurrency", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const toolMap = new Map<string, Tool>([
    [
      "webfetch",
      fakeTool("webfetch", {
        run: async () => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
          return { toolCallId: "x", name: "webfetch", content: "ok" };
        },
      }),
    ],
  ]);
  const calls = Array.from({ length: 5 }, () =>
    call("webfetch", { url: "http://x" }),
  );
  await new ToolExecutor({ maxParallelToolCalls: 2 }).run(
    calls,
    runCtx(toolMap),
    new AbortController().signal,
  );
  assert.equal(maxConcurrent, 2);
});
