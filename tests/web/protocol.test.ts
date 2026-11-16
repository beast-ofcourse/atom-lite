import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { startWebServer } from "../../dist/web/server.js";

interface WebRuntime {
  runtime: AgentRuntime;
  session: InMemorySession;
  approvals: any;
}

function buildRuntime(responses: any[], tools: any[] = []): WebRuntime {
  const workspace = mkdtempSync(join(tmpdir(), "web-ws-"));
  const runtime = new AgentRuntime({
    provider: new FakeProvider(responses),
    workspace,
    tools,
    mode: "yolo",
  });
  const session = new InMemorySession("s1", workspace);
  const approvals = {
    mode: "ask" as const,
    handler: undefined,
    isTrusted: () => false,
    trustSession: () => {},
    nonInteractive: false,
  };
  return { runtime, session, approvals };
}

async function start(built: WebRuntime) {
  return startWebServer({
    runtime: built.runtime,
    session: built.session,
    approvals: built.approvals,
    providerName: "fake",
    model: "fake-model",
    port: 0,
    openBrowser: false,
  });
}

/** A client that buffers every message from the moment it connects. */
class Client {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  private waiters: Array<{
    type: string;
    resolve: (m: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.type === msg.type) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  async open(): Promise<void> {
    await once(this.ws, "open");
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the first message of this type (past or future). */
  waitFor(type: string, timeoutMs = 5000): Promise<any> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Status code of a raw GET with exactly the given headers. */
function rawStatus(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("a tool call reaches the browser as card events in order", async () => {
  const echoTool = {
    definition: {
      name: "echo",
      description: "echo text",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
    annotations: { readOnlyHint: true },
    async execute(call: any, ctx: any) {
      ctx.onToolOutput?.(call, "stdout", "first chunk\n");
      ctx.onToolOutput?.(call, "stdout", "second chunk\n");
      return {
        toolCallId: call.id,
        name: "echo",
        content: "echoed",
      };
    },
  };
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "t1", name: "echo", arguments: { text: "hi" } }] },
      { text: "all done" },
    ],
    [echoTool as any],
  );
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "run the echo tool" });
    await client.waitFor("turn_end");

    const kinds = client.messages
      .filter((m) => m.type === "event")
      .map((m) => m.event.type)
      .filter((t) => t.startsWith("tool_"));
    assert.deepEqual(kinds, [
      "tool_call",
      "tool_output",
      "tool_output",
      "tool_result",
    ]);

    const call = client.messages.find(
      (m) => m.type === "event" && m.event.type === "tool_call",
    );
    assert.equal(call.event.id, "t1");
    assert.equal(call.event.name, "echo");
    assert.deepEqual(call.event.args, { text: "hi" });

    const output = client.messages
      .filter((m) => m.type === "event" && m.event.type === "tool_output")
      .map((m) => m.event.text)
      .join("");
    assert.equal(output, "first chunk\nsecond chunk\n");

    const result = client.messages.find(
      (m) => m.type === "event" && m.event.type === "tool_result",
    );
    assert.equal(result.event.toolCallId, "t1");
    assert.match(result.event.content, /echoed/);
  } finally {
    client.close();
    await server.close();
  }
});

test("the page is served only with the run token", async () => {
  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built);
  try {
    const withoutToken = await fetch(server.url.replace(/\?.*$/, ""));
    assert.equal(withoutToken.status, 401);

    const withToken = await fetch(server.url);
    assert.equal(withToken.status, 200);
    const html = await withToken.text();
    assert.match(html, /<html/i);
    assert.ok(
      !html.includes("__ATOM_LITE_TOKEN__"),
      "token placeholder replaced",
    );
  } finally {
    await server.close();
  }
});

test("requests with a foreign origin or host are rejected", async () => {
  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built);
  try {
    const foreignOrigin = await fetch(server.url, {
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(foreignOrigin.status, 403);

    // fetch() forbids overriding Host, so use a raw request for the
    // DNS-rebinding shape.
    const status = await rawStatus(server.port, { Host: "evil.example" });
    assert.equal(status, 403);
  } finally {
    await server.close();
  }
});

test("a client receives the greeting and a streamed reply to its message", async () => {
  const built = buildRuntime([{ text: "hello there" }]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const hello = await client.waitFor("hello");
    assert.equal(hello.sessionId, built.session.id);
    assert.equal(hello.model, "fake-model");
    assert.equal(hello.readOnly, false);

    client.send({ type: "input", text: "ping" });
    await client.waitFor("turn_end");

    const assistantText = client.messages
      .filter((m) => m.type === "event" && m.event?.type === "assistant_text")
      .map((m) => m.event.text)
      .join("");
    assert.equal(assistantText, "hello there");

    // The turn's input reached the runtime as the user message.
    assert.equal(built.session.messages[0].role, "user");
    assert.equal(built.session.messages[0].content[0].text, "ping");
  } finally {
    client.close();
    await server.close();
  }
});
