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
import { checkApproval } from "../../dist/runtime/approvals.js";
import {
  InMemorySession,
  JsonlSessionStore,
  type Session,
} from "../../dist/sessions/store.js";
import { startWebServer } from "../../dist/web/server.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../dist/types.js";

interface WebRuntime {
  runtime: AgentRuntime;
  session: Session;
  approvals: any;
  workspace: string;
}

interface BuildOptions {
  provider?: ProviderAdapter;
  tools?: any[];
  workspace?: string;
  session?: Session;
}

function buildRuntime(
  responses: any[] = [],
  options: BuildOptions = {},
): WebRuntime {
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "web-ws-"));
  let trusted = false;
  const approvals = {
    mode: "ask" as const,
    handler: undefined,
    isTrusted: () => trusted,
    trustSession: () => {
      trusted = true;
    },
    resetTrust: () => {
      trusted = false;
    },
    nonInteractive: false,
  };
  const runtime = new AgentRuntime({
    provider: options.provider ?? new FakeProvider(responses),
    workspace,
    tools: options.tools ?? [],
    mode: "yolo",
    approvals,
  });
  const session =
    options.session ?? new InMemorySession("s1", workspace, "fake");
  return { runtime, session, approvals, workspace };
}

async function start(
  built: WebRuntime,
  extras: { store?: JsonlSessionStore } = {},
) {
  return startWebServer({
    runtime: built.runtime,
    session: built.session,
    approvals: built.approvals,
    providerName: "fake",
    model: "fake-model",
    store: extras.store,
    workspace: built.workspace,
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
    return this.waitForNext(type, timeoutMs);
  }

  /** Resolve with the next message of this type, ignoring earlier ones. */
  waitForNext(type: string, timeoutMs = 5000): Promise<any> {
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

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Assistant text a client has received so far. */
function assistantTextOf(client: Client): string {
  return client.messages
    .filter((m) => m.type === "event" && m.event.type === "assistant_text")
    .map((m) => m.event.text)
    .join("");
}

/** History events a transcript renders; bookkeeping events are ignored. */
function historyMessages(events: any[] = []): any[] {
  return events.filter((event) =>
    ["user_message", "assistant_message", "tool_result"].includes(event.type),
  );
}

/** A provider that emits real deltas, so the stream is exercised end to end. */
class StreamingProvider implements ProviderAdapter {
  readonly id = "stream";
  readonly model = "stream-model";

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      toolCalls: [],
      finishReason: "stop",
    };
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "text", text: "hel" };
    yield { type: "text", text: "lo" };
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
        toolCalls: [],
        finishReason: "stop",
      },
    };
  }
}

/** A provider that fails before producing a response. */
class FailingProvider implements ProviderAdapter {
  readonly id = "fail";
  readonly model = "fail-model";

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("provider exploded");
  }
}

/**
 * A provider whose first request blocks until the test opens the gate, so the
 * test can send input while the turn is genuinely running.
 */
class GatedProvider implements ProviderAdapter {
  readonly id = "gated";
  readonly model = "gated-model";
  readonly requests: ModelRequest[] = [];
  private openGate!: () => void;
  private gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });

  open(): void {
    this.openGate();
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) await this.gate;
    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: `reply ${this.requests.length}` }],
      },
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

/**
 * A session whose first flush blocks until released, so a test can deliver
 * input exactly in the window between a turn finishing and `turn_end`.
 */
class SlowFlushSession implements Session {
  readonly inner: Session;
  flushCount = 0;
  private openFlush!: () => void;
  private firstFlush = new Promise<void>((resolve) => {
    this.openFlush = resolve;
  });

  constructor(inner: Session) {
    this.inner = inner;
  }

  get id(): string {
    return this.inner.id;
  }

  get workspace(): string {
    return this.inner.workspace;
  }

  get provider(): string {
    return this.inner.provider;
  }

  get messages(): Session["messages"] {
    return this.inner.messages;
  }

  set messages(messages: Session["messages"]) {
    this.inner.messages = messages;
  }

  get events() {
    return this.inner.events;
  }

  appendMessage(message: Parameters<Session["appendMessage"]>[0]): void {
    this.inner.appendMessage(message);
  }

  appendEvent(event: unknown): void {
    this.inner.appendEvent?.(event);
  }

  async flush(): Promise<void> {
    this.flushCount++;
    if (this.flushCount === 1) await this.firstFlush;
    await this.inner.flush?.();
  }

  release(): void {
    this.openFlush();
  }
}

/** A mutating tool that asks the runtime's approval context before running. */
function mutatingTool(log: string[]) {
  return {
    definition: {
      name: "mutate",
      description: "pretend to mutate the workspace",
      parameters: { type: "object", properties: {} },
    },
    annotations: { readOnlyHint: false },
    async execute(call: any, ctx: any) {
      const decision = await checkApproval(ctx.approvals, {
        command: "mutate the workspace",
        cwd: ctx.workspace,
        timeoutMs: 0,
        sandboxed: false,
        tool: "mutate",
      });
      log.push(decision.allowed ? "allowed" : "denied");
      return {
        toolCallId: call.id,
        name: "mutate",
        content: decision.allowed ? "mutated" : "MUTATION_DENIED",
        isError: !decision.allowed,
      };
    },
  };
}

function echoTool() {
  return {
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
}

// Reason: spec (ticket 01) — the page and its assets are only reachable with
// the per-run token; a local page without it must not drive the agent.
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
    assert.match(html, /\/app\.js\?token=/, "assets carry the token");
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 01, localhost hardening) — a foreign Origin is the
// localhost-CSRF shape and a foreign Host is the DNS-rebinding shape; both
// must be refused even with a valid token.
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

// Reason: spec (ticket 01) — the reply must arrive progressively, as deltas,
// not as one final blob; a regression here would make the UI feel frozen.
test("a streamed reply arrives as ordered deltas before turn_end", async () => {
  const built = buildRuntime([], { provider: new StreamingProvider() });
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

    const deltas = client.messages
      .filter((m) => m.type === "event" && m.event.type === "assistant_delta")
      .map((m) => m.event.text);
    assert.deepEqual(deltas, ["hel", "lo"]);

    const turnEndIndex = client.messages.findIndex(
      (m) => m.type === "turn_end",
    );
    let lastDeltaIndex = -1;
    client.messages.forEach((m, index) => {
      if (m.type === "event" && m.event.type === "assistant_delta") {
        lastDeltaIndex = index;
      }
    });
    assert.ok(lastDeltaIndex >= 0 && lastDeltaIndex < turnEndIndex);

    assert.equal(built.session.messages[0].role, "user");
    assert.equal(built.session.messages[0].content[0].text, "ping");
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 02) — the card protocol must preserve call, live
// output, and final result ordering; the client renders one card from it.
test("a tool call reaches the browser as card events in order", async () => {
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "t1", name: "echo", arguments: { text: "hi" } }] },
      { text: "all done" },
    ],
    { tools: [echoTool()] },
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

// Reason: spec (ticket 06) — input that arrives while the closing flush is in
// flight must still become part of the turn, not sit behind turn_end.
test("input during the closing flush is not stranded", async () => {
  const provider = new GatedProvider();
  provider.open();
  const workspace = mkdtempSync(join(tmpdir(), "web-ws-"));
  const session = new SlowFlushSession(
    new InMemorySession("slow", workspace, "gated"),
  );
  const built = buildRuntime([], { provider, session, workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "first" });
    await waitUntil(() => session.flushCount === 1, "the closing flush");

    client.send({ type: "input", text: "during flush" });
    await waitUntil(
      () => client.messages.some((m) => m.type === "input_queued"),
      "the queued input",
    );
    session.release();
    await client.waitFor("turn_end");

    assert.equal(provider.requests.length, 2);
    const userTexts = provider.requests[1].messages
      .filter((m) => m.role === "user")
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.map((p: any) => p.text ?? "").join("")
          : String(m.content ?? ""),
      );
    assert.deepEqual(userTexts, ["first", "during flush"]);
    assert.equal(
      client.messages.filter((m) => m.type === "turn_end").length,
      1,
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 05) — a second tab is a viewer: it receives the live
// stream, its input is refused with a message, and it takes control when the
// controller leaves.
test("two tabs share events and only the controller may drive", async () => {
  const built = buildRuntime([
    { text: "from controller" },
    { text: "from new controller" },
  ]);
  const server = await start(built);
  const a = new Client(server.wsUrl);
  const b = new Client(server.wsUrl);
  try {
    await a.open();
    const helloA = await a.waitFor("hello");
    assert.equal(helloA.readOnly, false);

    await b.open();
    const helloB = await b.waitFor("hello");
    assert.equal(helloB.readOnly, true);

    a.send({ type: "input", text: "hello" });
    await a.waitFor("turn_end");
    // turn_end is ordered after the reply on the same socket, so once the
    // viewer sees it, its transcript text is complete.
    await b.waitFor("turn_end");
    assert.match(assistantTextOf(a), /from controller/);
    assert.match(assistantTextOf(b), /from controller/);
    for (const client of [a, b]) {
      const prompts = client.messages
        .filter((m) => m.type === "user_input")
        .map((m) => m.text);
      assert.deepEqual(prompts, ["hello"], "both tabs see the prompt");
    }

    b.send({ type: "input", text: "sneaky" });
    const refused = await b.waitForNext("error");
    assert.match(refused.message, /read-only viewer/);

    a.close();
    const control = await b.waitForNext("control");
    assert.equal(control.readOnly, false);

    b.send({ type: "input", text: "now allowed" });
    await b.waitForNext("turn_end");
    assert.match(assistantTextOf(b), /from new controller/);
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});

// Reason: spec (ticket 06) — input typed while a turn runs is held and
// delivered in order as the following model turn, not dropped or reordered.
test("mid-turn input is queued and delivered in order", async () => {
  const provider = new GatedProvider();
  const built = buildRuntime([], { provider });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "first" });
    await client.waitFor("turn_start");
    await waitUntil(
      () => provider.requests.length === 1,
      "the first model request",
    );

    client.send({ type: "input", text: "queued one" });
    const q1 = await client.waitForNext("input_queued");
    assert.equal(q1.text, "queued one");
    client.send({ type: "input", text: "queued two" });
    const q2 = await client.waitForNext("input_queued");
    assert.equal(q2.text, "queued two");

    provider.open();
    await client.waitFor("turn_end");

    assert.equal(provider.requests.length, 2);
    const userTexts = provider.requests[1].messages
      .filter((m) => m.role === "user")
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.map((p: any) => p.text ?? "").join("")
          : String(m.content ?? ""),
      );
    assert.deepEqual(userTexts, ["first", "queued one", "queued two"]);

    const replies = client.messages
      .filter((m) => m.type === "event" && m.event.type === "assistant_text")
      .map((m) => m.event.text);
    assert.deepEqual(replies, ["reply 1", "reply 2"]);
    const prompts = client.messages
      .filter((m) => m.type === "user_input")
      .map((m) => m.text);
    assert.deepEqual(prompts, ["first", "queued one", "queued two"]);
    assert.equal(
      client.messages.filter((m) => m.type === "turn_end").length,
      1,
      "one turn_end covers the queued work",
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: regression — turn_end must not overtake the durable write when the
// provider fails; a client that resumes the log immediately must see the turn.
test("turn_end flushes the session on the error path", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake");
  const built = buildRuntime([], {
    provider: new FailingProvider(),
    workspace,
    session,
  });
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "this will fail" });
    await client.waitFor("turn_end");

    const reloaded = store.resume(session.id)!;
    const text = reloaded.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content[0].text)
      .join("\n");
    assert.match(text, /this will fail/);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — a mutating tool must block on the browser
// answer, carry the request details and waiting turn, then proceed.
test("an approval request blocks the turn until approved", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "a1", name: "mutate", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "mutate please" });

    const request = await client.waitFor("approval_request");
    assert.equal(request.request.command, "mutate the workspace");
    assert.equal(request.request.tool, "mutate");
    assert.equal(request.request.cwd, built.workspace);
    assert.ok(request.id);
    assert.ok(request.turnId > 0);
    assert.ok(
      !client.messages.some((m) => m.type === "turn_end"),
      "the turn is still blocked while the approval is pending",
    );

    client.send({
      type: "approval",
      id: request.id,
      turnId: request.turnId,
      decision: "approve",
    });
    await client.waitFor("turn_end");

    assert.deepEqual(log, ["allowed"]);
    const toolMessage = built.session.messages.find((m) => m.role === "tool");
    assert.equal(toolMessage.content, "mutated");
    assert.ok(!toolMessage.isError);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — deny stops the tool but not the turn; the agent
// continues with the denial and the transcript records it.
test("deny stops the tool and the turn continues", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "a1", name: "mutate", arguments: {} }] },
      { text: "continuing after denial" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "mutate please" });
    const request = await client.waitFor("approval_request");
    client.send({
      type: "approval",
      id: request.id,
      turnId: request.turnId,
      decision: "deny",
    });
    await client.waitFor("turn_end");

    assert.deepEqual(log, ["denied"]);
    const toolMessage = built.session.messages.find((m) => m.role === "tool");
    assert.equal(toolMessage.content, "MUTATION_DENIED");
    assert.equal(toolMessage.isError, true);
    const finalText = built.session.messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.map((p: any) => p.text ?? "").join("")
          : String(m.content ?? ""),
      )
      .join("");
    assert.match(finalText, /continuing after denial/);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — trust-for-session is scoped to this server
// session and must suppress later prompts without touching shared config.
test("trust-for-session lets later matching requests through", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "a1", name: "mutate", arguments: {} }] },
      { toolCalls: [{ id: "a2", name: "mutate", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "mutate twice" });
    const request = await client.waitFor("approval_request");
    client.send({
      type: "approval",
      id: request.id,
      turnId: request.turnId,
      decision: "trust-session",
    });
    await client.waitFor("turn_end");

    assert.deepEqual(log, ["allowed", "allowed"]);
    const requests = client.messages.filter(
      (m) => m.type === "approval_request",
    );
    assert.equal(requests.length, 1);
    assert.equal(built.approvals.isTrusted(), true);

    // Trust belongs to the conversation, matching the terminal: starting a
    // fresh session asks again.
    client.send({ type: "new_session" });
    await client.waitForNext("session_changed");
    assert.equal(built.approvals.isTrusted(), false);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — a browser that disappears while an approval is
// pending must not strand the turn; the request fails safe as a denial.
test("a pending approval fails safe when the only client disconnects", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "a1", name: "mutate", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    client.send({ type: "input", text: "mutate please" });
    await client.waitFor("approval_request");
    client.close();

    await waitUntil(
      () => built.session.messages.some((m) => m.role === "tool"),
      "the denied tool result",
    );
    assert.deepEqual(log, ["denied"]);
    const toolMessage = built.session.messages.find((m) => m.role === "tool");
    assert.equal(toolMessage.isError, true);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 04) — the browser lists workspace sessions, creates a
// new one, resumes an old one, and every turn lands in the same JSONL log the
// terminal reads; sessions from other workspaces are never offered.
test("sessions are listed, created, resumed, and persisted", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const otherWorkspace = mkdtempSync(join(tmpdir(), "web-other-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake");
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "h1", name: "echo", arguments: { text: "x" } }] },
      { text: "first reply" },
      { text: "new session reply" },
    ],
    { tools: [echoTool()], workspace, session },
  );
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const hello = await client.waitFor("hello");
    assert.equal(hello.sessionId, session.id);
    assert.deepEqual(historyMessages(hello.history), []);

    client.send({ type: "input", text: "first question" });
    await client.waitFor("turn_end");

    // Another workspace's session exists in the same store but must not be
    // listed or resumable from this workspace.
    const other = store.create(otherWorkspace, "fake");
    other.appendMessage({
      role: "user",
      content: [{ type: "text", text: "other workspace" }],
    });
    await other.flush();

    client.send({ type: "list_sessions" });
    const listing = await client.waitFor("sessions");
    assert.equal(listing.sessions.length, 1);
    const summary = listing.sessions[0];
    assert.equal(summary.id, session.id);
    assert.equal(summary.title, "first question");
    assert.ok(summary.messageCount >= 3);
    assert.ok(summary.updatedAt);

    client.send({ type: "resume_session", id: other.id });
    const foreignError = await client.waitForNext("error");
    assert.match(foreignError.message, /another workspace|no session/);

    client.send({ type: "new_session" });
    const changed = await client.waitForNext("session_changed");
    assert.ok(changed.sessionId);
    assert.notEqual(changed.sessionId, session.id);
    assert.deepEqual(historyMessages(changed.history), []);
    const newSessionId = changed.sessionId;

    client.send({ type: "input", text: "new question" });
    await client.waitForNext("turn_end");

    client.send({ type: "resume_session", id: session.id });
    const resumed = await client.waitForNext("session_changed");
    assert.equal(resumed.sessionId, session.id);
    const historyKinds = resumed.history.map((e: any) => e.type);
    assert.ok(historyKinds.includes("user_message"));
    assert.ok(historyKinds.includes("assistant_message"));
    assert.ok(historyKinds.includes("tool_result"));
    const userEvent = resumed.history.find(
      (e: any) => e.type === "user_message",
    );
    assert.equal(userEvent.message.content[0].text, "first question");
    const assistantEvent = resumed.history.find(
      (e: any) =>
        e.type === "assistant_message" &&
        Array.isArray(e.message.toolCalls) &&
        e.message.toolCalls.length > 0,
    );
    assert.equal(assistantEvent.message.toolCalls[0].name, "echo");

    // The durable log is the same one the terminal reads.
    const reloaded = store.resume(session.id)!;
    const reloadedText = reloaded.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content[0].text)
      .join("\n");
    assert.match(reloadedText, /first question/);
    const newReloaded = store.resume(newSessionId)!;
    const newText = newReloaded.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content[0].text)
      .join("\n");
    assert.match(newText, /new question/);
  } finally {
    client.close();
    await server.close();
  }
});
