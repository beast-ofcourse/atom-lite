import { test } from "node:test";
import assert from "node:assert/strict";
import { McpManager, createMcpTools } from "../../dist/mcp/index.js";
import { summariseMcpResult } from "../../dist/mcp/tools.js";
import { checkApproval } from "../../dist/runtime/approvals.js";

function makeFactory(state: any) {
  class FakeTransport {
    name: string;
    st: any;
    handlers: any;
    constructor(name: string, st: any) {
      this.name = name;
      this.st = st;
    }
    setHandlers(h: any) { this.handlers = h; }
    async start() { const s = this.st.servers[this.name]; if (s?.failConnect) throw new Error(s.failConnect); }
    send(msg: any) {
      const s = this.st.servers[this.name];
      if (msg.method === "initialize") queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: this.name } } }));
      else if (msg.method === "tools/list") queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: { tools: s?.tools ?? [] } }));
      else if (msg.method === "tools/call") {
        if (s?.callError) queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: s.callError } }));
        else queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: s?.callResult ?? { content: [{ type: "text", text: "ok" }] } }));
      }
    }
    async close() {}
    stderrText() { return ""; }
  }
  return (name: string) => new FakeTransport(name, state);
}

test("summariseMcpResult maps text and non-text", () => {
  const result = {
    content: [
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "resource", resource: { uri: "file:///x", mimeType: "text/plain", blob: "hi" } },
    ],
    isError: false,
  };
  const text = summariseMcpResult(result);
  assert.match(text, /hello/);
  assert.match(text, /\[image\/png 3 bytes\]/);
  assert.match(text, /\[text\/plain 1 bytes\]/);
});

test("isError is honoured", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }], callResult: { content: [{ type: "text", text: "bad" }], isError: true } } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const [tool] = createMcpTools(manager);
  const res = await tool.execute({ id: "1", name: tool.definition.name, arguments: {} }, { workspace: "/tmp", signal: new AbortController().signal });
  assert.equal(res.isError, true);
  assert.match(res.content, /bad/);
});

test("server error becomes MCP_CALL_FAILED", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }], callError: "nope" } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const [tool] = createMcpTools(manager);
  const res = await tool.execute({ id: "1", name: tool.definition.name, arguments: {} }, { workspace: "/tmp", signal: new AbortController().signal });
  assert.equal(res.isError, true);
  assert.match(res.content, /MCP_CALL_FAILED/);
});

test("requiresApproval denied returns MCP_APPROVAL_REQUIRED", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }], callResult: { content: [{ type: "text", text: "secret" }] } } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, requiresApproval: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const [tool] = createMcpTools(manager);
  const approvals = { mode: "ask", isTrusted: () => false, trustSession: () => {}, nonInteractive: false, handler: async () => "deny" } as any;
  const res = await tool.execute({ id: "1", name: tool.definition.name, arguments: { a: 1 } }, { workspace: "/tmp", signal: new AbortController().signal, approvals });
  assert.equal(res.isError, true);
  assert.match(res.content, /MCP_APPROVAL_REQUIRED/);
});

test("requiresApproval approved executes", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }], callResult: { content: [{ type: "text", text: "done" }] } } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, requiresApproval: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const [tool] = createMcpTools(manager);
  const approvals = { mode: "ask", isTrusted: () => false, trustSession: () => {}, nonInteractive: false, handler: async () => "approve" } as any;
  const res = await tool.execute({ id: "1", name: tool.definition.name, arguments: {} }, { workspace: "/tmp", signal: new AbortController().signal, approvals });
  assert.equal(res.isError, false);
  assert.match(res.content, /done/);
});

test("descriptions and schemas pass through", async () => {
  const state = { servers: { srv: { tools: [{ name: "t", description: "desc", inputSchema: { type: "object", properties: { n: { type: "number" } } } }] } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const [tool] = createMcpTools(manager);
  assert.equal(tool.definition.description, "desc");
  assert.equal((tool.definition.parameters as any).properties.n.type, "number");
});
