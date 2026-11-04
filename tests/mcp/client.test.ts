import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpError } from "../../dist/mcp/client.js";

class FakeTransport {
  handlers: any;
  sent: any[] = [];
  started = false;
  closed = false;
  respondTo: Record<string, (msg: any) => any> = {};

  setHandlers(h: any) {
    this.handlers = h;
  }
  async start() {
    this.started = true;
  }
  send(msg: any) {
    this.sent.push(msg);
    if (msg.method === "initialize") {
      queueMicrotask(() =>
        this.handlers.onMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake" },
          },
        }),
      );
    } else if (msg.method === "tools/list") {
      queueMicrotask(() =>
        this.handlers.onMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          },
        }),
      );
    } else if (msg.method === "tools/call") {
      queueMicrotask(() =>
        this.handlers.onMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `echo:${msg.params.arguments.text}` }],
            isError: false,
          },
        }),
      );
    } else if (msg.method === "ping") {
      queueMicrotask(() =>
        this.handlers.onMessage({ jsonrpc: "2.0", id: msg.id, result: {} }),
      );
    }
  }
  close() {
    this.closed = true;
  }
  emitNotification(method: string, params: unknown) {
    queueMicrotask(() =>
      this.handlers.onMessage({ jsonrpc: "2.0", method, params }),
    );
  }
  emitClose(code = 1) {
    this.handlers.onClose({ code, signal: null });
  }
}

test("connect negotiates protocol and sends initialized", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  const result = await client.connect({ startupTimeoutMs: 1000 });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(transport.started, true);
  assert.ok(
    transport.sent.some((m) => m.method === "notifications/initialized"),
  );
});

test("listTools and callTool round trip", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");
  const result: any = await client.callTool("echo", { text: "hi" });
  assert.equal(result.content[0].text, "echo:hi");
});

test("ping works", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  await client.ping();
  assert.ok(transport.sent.some((m) => m.method === "ping"));
});

test("unsupported protocol version fails clearly", async () => {
  const transport = new FakeTransport();
  // Override initialize response.
  const origSend = transport.send.bind(transport);
  transport.send = (msg: any) => {
    if (msg.method === "initialize") {
      queueMicrotask(() =>
        transport.handlers.onMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "1999-01-01", capabilities: {} },
        }),
      );
      return;
    }
    origSend(msg);
  };
  const client = new McpClient(transport);
  await assert.rejects(
    () => client.connect({ startupTimeoutMs: 1000 }),
    (err: Error) => /Unsupported MCP protocol version/.test(err.message),
  );
});

test("request timeout rejects and sends cancelled", async () => {
  const transport = new FakeTransport();
  const origSend = transport.send.bind(transport);
  transport.send = (msg: any) => {
    if (msg.method === "tools/list") {
      // never respond
      transport.sent.push(msg);
      return;
    }
    origSend(msg);
  };
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  await assert.rejects(
    () => client.listTools({ timeoutMs: 20 }),
    (err: Error) => /timed out/.test(err.message),
  );
  assert.ok(
    transport.sent.some(
      (m) =>
        m.method === "notifications/cancelled" &&
        m.params?.requestId !== undefined,
    ),
  );
});

test("abort signal cancels an in-flight request", async () => {
  const transport = new FakeTransport();
  const origSend = transport.send.bind(transport);
  transport.send = (msg: any) => {
    if (msg.method === "tools/list") {
      transport.sent.push(msg);
      return;
    }
    origSend(msg);
  };
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  const controller = new AbortController();
  const promise = client.listTools({ timeoutMs: 10000, signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(
    () => promise,
    (err: Error) => err.message === "USER_CANCELLED",
  );
});

test("list_changed notification is delivered", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  let seen = false;
  client.onNotification("notifications/tools/list_changed", () => {
    seen = true;
  });
  transport.emitNotification("notifications/tools/list_changed", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen, true);
});

test("unexpected transport close rejects pending requests", async () => {
  const transport = new FakeTransport();
  const origSend = transport.send.bind(transport);
  transport.send = (msg: any) => {
    if (msg.method === "tools/list") {
      transport.sent.push(msg);
      return;
    }
    origSend(msg);
  };
  const client = new McpClient(transport);
  await client.connect({ startupTimeoutMs: 1000 });
  const promise = client.listTools({ timeoutMs: 10000 });
  transport.emitClose(1);
  await assert.rejects(
    () => promise,
    (err: Error) => /exited/.test(err.message),
  );
});
