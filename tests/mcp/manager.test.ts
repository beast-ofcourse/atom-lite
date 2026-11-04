import { test } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../../dist/mcp/manager.js";
import { formatMcpStatus } from "../../dist/mcp/format.js";

class FakeTransport {
  name: string;
  state: any;
  handlers: any;
  sent: any[] = [];
  started = false;
  closed = false;
  constructor(name: string, state: any) {
    this.name = name;
    this.state = state;
  }
  setHandlers(h: any) { this.handlers = h; }
  async start() { this.started = true; const s = this.state.servers[this.name]; if (s?.failConnect) throw new Error(s.failConnect); }
  send(msg: any) {
    this.sent.push(msg);
    const s = this.state.servers[this.name];
    if (msg.method === "initialize") {
      queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: this.name } } }));
    } else if (msg.method === "tools/list") {
      if (s?.failList) {
        queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: s.failList } }));
        return;
      }
      queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: { tools: s?.tools ?? [] } }));
    } else if (msg.method === "tools/call") {
      if (s?.failCall) {
        queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: s.failCall } }));
        return;
      }
      const result = s?.callResult ?? { content: [{ type: "text", text: "ok" }] };
      queueMicrotask(() => this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result }));
    }
  }
  async close() { this.closed = true; }
  emitNotification(method: string, params: unknown) {
    queueMicrotask(() => this.handlers?.onMessage({ jsonrpc: "2.0", method, params }));
  }
  emitClose(code = 1) {
    this.handlers?.onClose({ code, signal: null });
  }
  stderrText() { return this.state.servers[this.name]?.stderr ?? ""; }
}

function makeFactory(state: any) {
  return (name: string) => new FakeTransport(name, state);
}

test("lazy connect and namespaced tools", async () => {
  const state = {
    servers: {
      srv: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
    },
  };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, requiresApproval: false, startupTimeoutMs: 1000, callTimeoutMs: 1000, args: [], env: {} } }, transportFactory: makeFactory(state) });
  assert.equal(manager.status()[0].state, "idle");
  const tools = await manager.syncTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp__srv__echo");
  assert.equal(manager.status()[0].state, "ready");
  assert.equal(manager.status()[0].toolCount, 1);
});

test("disabled server never connects", async () => {
  const state = { servers: { srv: { tools: [] } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: false, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  const tools = await manager.syncTools();
  assert.equal(tools.length, 0);
  assert.equal(manager.status()[0].state, "disabled");
});

test("failed server is isolated and reported", async () => {
  const state = {
    servers: {
      bad: { failConnect: "boom", tools: [] },
      good: { tools: [{ name: "t", description: "T" }] },
    },
  };
  const events: any[] = [];
  const manager = new McpManager({
    servers: {
      bad: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 },
      good: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 },
    },
    transportFactory: makeFactory(state),
    onEvent: (e) => events.push(e),
  });
  const tools = await manager.syncTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].server, "good");
  assert.equal(manager.status().find((s) => s.name === "bad")?.state, "failed");
  assert.ok(events.some((e) => e.type === "mcp_server_failed" && e.server === "bad"));
});

test("callTool returns raw MCP result", async () => {
  const state = { servers: { srv: { tools: [{ name: "echo" }], callResult: { content: [{ type: "text", text: "pong" }], isError: false } } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const result: any = await manager.callTool("srv", "echo", { x: 1 });
  assert.equal(result.content[0].text, "pong");
});

test("callTool on failed server throws", async () => {
  const state = { servers: { srv: { failConnect: "boom" } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  await assert.rejects(() => manager.callTool("srv", "echo", {}), /MCP_SERVER_UNAVAILABLE/);
});

test("list_changed refreshes tool list", async () => {
  const state = { servers: { srv: { tools: [{ name: "a" }] } } };
  const events: any[] = [];
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state), onEvent: (e) => events.push(e) });
  await manager.syncTools();
  assert.equal(manager.tools().length, 1);
  // change remote tools
  state.servers.srv.tools = [{ name: "a" }, { name: "b" }];
  const transport = (manager as any).records?.get?.("srv")?.transport;
  // emit via stored transport
  const rec = (manager as any).records.get("srv");
  rec.transport.emitNotification("notifications/tools/list_changed", {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.tools().length, 2);
  assert.ok(events.some((e) => e.type === "mcp_tools_changed"));
});

test("reconnect retries a failed server", async () => {
  const state = { servers: { srv: { failConnect: "boom", tools: [{ name: "t" }] } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  assert.equal(manager.status()[0].state, "failed");
  // fix server
  delete state.servers.srv.failConnect;
  const statuses = await manager.reconnect("srv");
  assert.equal(statuses[0].state, "ready");
  assert.equal(statuses[0].toolCount, 1);
});

test("reconnect unknown server throws", async () => {
  const manager = new McpManager({ servers: {} });
  await assert.rejects(() => manager.reconnect("nope"), /Unknown MCP server/);
});

test("unexpected close marks server failed", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }] } } };
  const events: any[] = [];
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state), onEvent: (e) => events.push(e) });
  await manager.syncTools();
  const rec = (manager as any).records.get("srv");
  rec.transport.emitClose(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.status()[0].state, "failed");
  assert.ok(events.some((e) => e.type === "mcp_server_failed"));
});

test("close shuts down", async () => {
  const state = { servers: { srv: { tools: [] } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  await manager.close();
  assert.equal(manager.status()[0].state, "closed");
});

test("formatMcpStatus", async () => {
  const state = { servers: { srv: { tools: [{ name: "t" }] } } };
  const manager = new McpManager({ servers: { srv: { command: "fake", enabled: true, requiresApproval: true, args: [], env: {}, startupTimeoutMs: 1000, callTimeoutMs: 1000 } }, transportFactory: makeFactory(state) });
  await manager.syncTools();
  const text = formatMcpStatus(manager.status());
  assert.match(text, /srv: ready \(1 tool\) \[requires approval\]/);
});
