import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { todoTool } from "../../dist/tools/todo.js";
import { checkApproval } from "../../dist/runtime/approvals.js";
import {
  InMemorySession,
  JsonlSessionStore,
  type Session,
} from "../../dist/sessions/store.js";
import { startWebServer, webThemeFor } from "../../dist/web/server.js";
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
  extras: {
    store?: JsonlSessionStore;
    theme?: "light" | "dark";
    approvalGraceMs?: number;
    maxClients?: number;
    maxMessageBytes?: number;
    maxReplayBytes?: number;
    models?: { provider: string; model: string; label?: string }[];
    switchModel?: (provider: string, model: string) => any;
    mode?: "plan" | "yolo";
    effort?: string;
    setMode?: (mode: "plan" | "yolo") => void;
    setEffort?: (effort: string) => void;
    refreshModels?: () => Promise<any[]>;
    skills?: () => any[];
    mcpStatus?: () => any[];
    allowedHost?: string;
  } = {},
) {
  return startWebServer({
    runtime: built.runtime,
    session: built.session,
    approvals: built.approvals,
    providerName: "fake",
    model: "fake-model",
    store: extras.store,
    workspace: built.workspace,
    theme: extras.theme,
    models: extras.models,
    switchModel: extras.switchModel,
    mode: extras.mode,
    effort: extras.effort,
    setMode: extras.setMode,
    setEffort: extras.setEffort,
    refreshModels: extras.refreshModels,
    skills: extras.skills,
    mcpStatus: extras.mcpStatus,
    approvalGraceMs: extras.approvalGraceMs,
    maxClients: extras.maxClients,
    maxMessageBytes: extras.maxMessageBytes,
    maxReplayBytes: extras.maxReplayBytes,
    allowedHost: extras.allowedHost,
    port: 0,
    openBrowser: false,
  });
}

/** A client that buffers every message from the moment it connects. */
class Client {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  private waiters: Array<{
    matches: (message: any) => boolean;
    resolve: (m: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.matches(msg)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await once(this.ws, "open");
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the first matching message (past or future). */
  waitFor(type: string, timeoutMs = 5000): Promise<any> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return this.waitForMatching((m) => m.type === type, timeoutMs);
  }

  /** Resolve with the next message of this type, ignoring earlier ones. */
  waitForNext(type: string, timeoutMs = 5000): Promise<any> {
    return this.waitForMatching((m) => m.type === type, timeoutMs);
  }

  /** Resolve with the first message matching an arbitrary predicate. */
  waitForMatching(
    matches: (message: any) => boolean,
    timeoutMs = 5000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error("timed out waiting for a matching message"));
      }, timeoutMs);
      this.waiters.push({ matches, resolve, reject, timer });
    });
  }

  /** Resolve with a past or future message matching an arbitrary predicate. */
  waitForMatchingIncludingPast(
    matches: (message: any) => boolean,
    timeoutMs = 5000,
  ): Promise<any> {
    const existing = this.messages.find(matches);
    if (existing) return Promise.resolve(existing);
    return this.waitForMatching(matches, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

/** Status code of a raw GET with exactly the given headers. */
function rawStatus(
  port: number,
  headers: Record<string, string>,
  path = "/",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers },
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

/** Wait for one runtime event of a given type. */
function waitForEvent(client: Client, type: string, timeoutMs = 5000) {
  return client.waitForMatching(
    (m) => m.type === "event" && m.event?.type === type,
    timeoutMs,
  );
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

/** A provider that bursts output, then holds the turn open. */
class BurstProvider implements ProviderAdapter {
  readonly id = "burst";
  readonly model = "burst-model";
  private openGate!: () => void;
  private gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });

  open(): void {
    this.openGate();
  }

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("unused");
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    const text = "x".repeat(100);
    for (let i = 0; i < 50; i++) {
      yield { type: "text", text };
    }
    await this.gate;
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: text.repeat(50) }],
        },
        toolCalls: [],
        finishReason: "stop",
      },
    };
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

/** A streaming provider whose thinking is folded into the final message. */
class ThinkingProvider implements ProviderAdapter {
  readonly id = "thinking";
  readonly model = "thinking-model";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
      toolCalls: [],
      finishReason: "stop",
    };
  }

  async *stream(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "thinking", text: "Weigh the options." };
    yield { type: "text", text: "answer" };
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
        toolCalls: [],
        finishReason: "stop",
      },
    };
  }
}

/**
 * A provider whose first request blocks until the turn is aborted. The signal
 * rejection uses the browser/fetch abort wording rather than USER_CANCELLED,
 * so the server must key the stopped state off the signal itself.
 */
class AbortableProvider implements ProviderAdapter {
  readonly id = "abortable";
  readonly model = "abortable-model";
  started = false;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.started = true;
    return await new Promise<ModelResponse>((_, reject) => {
      const signal = request.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new Error("This operation was aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("This operation was aborted")),
        { once: true },
      );
    });
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

/** A tool that asks approval, emits output, then blocks until released. */
function gatedTool() {
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    open: () => openGate(),
    tool: {
      definition: {
        name: "slow",
        description: "ask, stream, then wait",
        parameters: { type: "object", properties: {} },
      },
      annotations: { readOnlyHint: false },
      async execute(call: any, ctx: any) {
        const decision = await checkApproval(ctx.approvals, {
          command: "slow work",
          cwd: ctx.workspace,
          timeoutMs: 0,
          sandboxed: false,
          tool: "slow",
        });
        if (!decision.allowed) {
          return {
            toolCallId: call.id,
            name: "slow",
            content: "SLOW_DENIED",
            isError: true,
          };
        }
        ctx.onToolOutput?.(call, "stdout", "chunk\n");
        await gate;
        return {
          toolCallId: call.id,
          name: "slow",
          content: "finished",
        };
      },
    },
  };
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
    assert.match(html, /data-theme="dark"/);
    assert.match(
      html,
      new RegExp(`window\\.__ATOM_TOKEN__ = "${server.token}";`),
      "the token is injected as a string value",
    );
    assert.ok(
      !html.includes(`window.${server.token}`),
      "the token is never spliced into an identifier",
    );
    assert.ok(
      !html.includes("__ATOM_LITE_TOKEN__"),
      "token placeholder replaced",
    );
    assert.match(html, /\/app\.js\?token=/, "assets carry the token");
    assert.match(
      html,
      /\/vendor\/markdown-it\.min\.js\?token=/,
      "vendored renderer carries the token",
    );

    const vendor = await fetch(
      `http://127.0.0.1:${server.port}/vendor/markdown-it.min.js?token=${server.token}`,
    );
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 09) — the configured UI theme maps onto light/dark for
// the web surface, and no-colour defaults to light.
test("the web theme follows the configured theme", async () => {
  assert.equal(webThemeFor("light"), "light");
  assert.equal(webThemeFor("ansi"), "light");
  assert.equal(webThemeFor("solarized"), "light");
  assert.equal(webThemeFor("auto"), "dark");
  assert.equal(webThemeFor("dracula"), "dark");
  assert.equal(webThemeFor("dark"), "dark");

  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built, { theme: "light" });
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /data-theme="light"/);
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

// Reason: share mode publishes one HTTPS hostname. That host and its Origin
// are accepted; every other host stays forbidden, and the token still gates
// access.
test("a published share host is accepted alongside localhost", async () => {
  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built, { allowedHost: "phone.example.test" });
  const path = `/?token=${encodeURIComponent(server.token)}`;
  try {
    assert.equal(
      await rawStatus(server.port, { Host: "phone.example.test" }, path),
      200,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "phone.example.test", Origin: "https://phone.example.test" },
        path,
      ),
      200,
    );
    assert.equal(
      await rawStatus(server.port, { Host: "evil.example" }, path),
      403,
    );
    assert.equal(
      await rawStatus(server.port, { Host: "phone.example.test" }),
      401,
    );

    server.setAllowedHost("other.example.test");
    assert.equal(
      await rawStatus(server.port, { Host: "phone.example.test" }, path),
      403,
    );
    assert.equal(
      await rawStatus(server.port, { Host: "other.example.test" }, path),
      200,
    );
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

    const prompts = client.messages
      .filter((m) => m.type === "user_input")
      .map((m) => m.text);
    assert.deepEqual(prompts, ["ping"]);
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

// Reason: spec (ticket 07) — a socket drop mid-turn must not lose or re-run
// work: the reconnect carries the active turn exactly once, the turn finishes,
// an already-answered approval is not shown again, and the buffer is released.
test("a reconnecting client replays the active turn exactly once", async () => {
  const slow = gatedTool();
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "r1", name: "slow", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [slow.tool] },
  );
  const server = await start(built);
  const a = new Client(server.wsUrl);
  let b: Client | undefined;
  let c: Client | undefined;
  try {
    await a.open();
    a.send({ type: "input", text: "start" });
    const approval = await a.waitFor("approval_request");
    a.send({
      type: "approval",
      id: approval.id,
      turnId: approval.turnId,
      decision: "approve",
    });
    await waitForEvent(a, "tool_output");
    a.close();

    b = new Client(server.wsUrl);
    await b.open();
    const hello = await b.waitFor("hello");
    assert.deepEqual(historyMessages(hello.history), []);

    const replay = await b.waitFor("replay");
    assert.ok(replay.turnId > 0);
    assert.deepEqual(replay.prompts, ["start"]);
    assert.deepEqual(
      replay.events
        .filter((e: any) => e.type.startsWith("tool_"))
        .map((e: any) => e.type),
      ["tool_call", "tool_output"],
    );
    assert.deepEqual(
      replay.events
        .filter((e: any) => e.type === "tool_output")
        .map((e: any) => e.text),
      ["chunk\n"],
    );

    // The approval was answered before the drop; nothing prompts again.
    b.send({ type: "list_sessions" });
    await b.waitFor("sessions");
    assert.ok(!b.messages.some((m) => m.type === "approval_request"));

    slow.open();
    await b.waitFor("turn_end");

    const replayedKinds = replay.events
      .filter((e: any) => e.type.startsWith("tool_"))
      .map((e: any) => e.type);
    const liveKinds = b.messages
      .filter((m) => m.type === "event")
      .map((m) => m.event)
      .filter((e: any) => e.type.startsWith("tool_"))
      .map((e: any) => e.type);
    assert.deepEqual(
      [...replayedKinds, ...liveKinds],
      ["tool_call", "tool_output", "tool_result"],
      "each tool event arrives once",
    );
    assert.equal(assistantTextOf(b), "done");

    // turn_end releases the buffer; a late joiner renders the turn from the
    // session history and receives no replay.
    c = new Client(server.wsUrl);
    await c.open();
    const lateHello = await c.waitFor("hello");
    assert.deepEqual(
      historyMessages(lateHello.history).map((e: any) => e.type),
      ["user_message", "assistant_message", "tool_result", "assistant_message"],
    );
    c.send({ type: "list_sessions" });
    await c.waitFor("sessions");
    assert.ok(!c.messages.some((m) => m.type === "replay"));
  } finally {
    slow.open();
    a.close();
    b?.close();
    c?.close();
    await server.close();
  }
});

// Reason: spec (ticket 08) — the browser must refuse to open a session that
// another process holds and name the holder instead of writing to it.
test("the browser refuses a session held by another process", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const store = new JsonlSessionStore({ rootDir: storeRoot, lockReclaimMs: 5 });
  const held = store.create(workspace, "fake", "held");
  held.appendMessage({
    role: "user",
    content: [{ type: "text", text: "held elsewhere" }],
  });
  await held.flush();
  held.releaseLock();

  const holder = spawn(
    process.execPath,
    [
      resolve("tests/fixtures/hold-session-lock.mjs"),
      join(storeRoot, "held.jsonl.lock"),
      "held",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await once(holder.stdout!, "data");
  try {
    const built = buildRuntime([], {
      workspace,
      session: store.create(workspace, "fake", "server"),
    });
    const server = await start(built, { store });
    const client = new Client(server.wsUrl);
    try {
      await client.open();
      const hello = await client.waitFor("hello");
      client.send({ type: "resume_session", id: "held" });
      const error = await client.waitForNext("error");
      assert.match(error.message, new RegExp(`PID ${holder.pid}`));
      assert.notEqual(hello.sessionId, "held");
    } finally {
      client.close();
      await server.close();
    }
  } finally {
    holder.kill("SIGKILL");
    await once(holder, "exit");
  }
});

// Reason: spec (ticket 07) — a prompt that was open when the socket dropped
// must come back on reconnect, so a blip does not silently deny the tool.
test("a pending approval returns to the reconnecting client", async () => {
  const slow = gatedTool();
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "p1", name: "slow", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [slow.tool] },
  );
  const server = await start(built, { approvalGraceMs: 5_000 });
  const a = new Client(server.wsUrl);
  let b: Client | undefined;
  try {
    await a.open();
    a.send({ type: "input", text: "start" });
    const first = await a.waitFor("approval_request");
    a.close();

    b = new Client(server.wsUrl);
    await b.open();
    const again = await b.waitFor("approval_request");
    assert.equal(again.id, first.id, "the same pending prompt returns");

    b.send({
      type: "approval",
      id: again.id,
      turnId: again.turnId,
      decision: "approve",
    });
    await waitForEvent(b, "tool_output");
    slow.open();
    await b.waitFor("turn_end");

    const result = b.messages.find(
      (m) => m.type === "event" && m.event.type === "tool_result",
    );
    assert.equal(result.event.content, "finished");
    assert.ok(!result.event.isError);
  } finally {
    slow.open();
    a.close();
    b?.close();
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
    assert.equal(assistantTextOf(a), "from controller");
    assert.equal(assistantTextOf(b), "from controller");
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
    const replies = b.messages
      .filter((m) => m.type === "event" && m.event.type === "assistant_text")
      .map((m) => m.event.text);
    assert.deepEqual(replies, ["from controller", "from new controller"]);
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

// Reason: Escape is the web equivalent of the TUI's cancel key. Stopping must
// end the turn cleanly (stopped: true) without surfacing USER_CANCELLED as an
// error toast.
test("the controller stops a running turn", async () => {
  const provider = new AbortableProvider();
  const built = buildRuntime([], { provider });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "input", text: "long running turn" });
    await client.waitFor("turn_start");
    await waitUntil(() => provider.started, "the provider request");

    client.send({ type: "stop" });
    const stopping = await client.waitFor("turn_stopping");
    assert.equal(stopping.type, "turn_stopping");

    const end = await client.waitFor("turn_end");
    assert.equal(end.stopped, true);
    assert.ok(
      !client.messages.some((message) => message.type === "error"),
      "a cancelled turn is not reported as an error",
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

// Reason: regression — `.approval-layer { display: grid }` overrides the
// browser's [hidden] rule, so the dialog rendered before any request existed
// and its buttons had nothing to answer.
test("the stylesheet keeps hidden elements hidden", async () => {
  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built);
  try {
    const css = await (
      await fetch(
        `http://127.0.0.1:${server.port}/styles.css?token=${server.token}`,
      )
    ).text();
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none/, "[hidden] wins");
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 11) — an oversized frame is refused at the socket
// boundary without taking the server down for the next client.
test("oversized client messages are rejected without destabilising", async () => {
  const built = buildRuntime([{ text: "still here" }]);
  const server = await start(built, { maxMessageBytes: 1024 });
  const noisy = new Client(server.wsUrl);
  let healthy: Client | undefined;
  try {
    await noisy.open();
    const closed = once(noisy.ws, "close");
    noisy.send({ type: "input", text: "x".repeat(4096) });
    const [code] = (await closed) as [number];
    assert.equal(code, 1009);
    noisy.close();

    healthy = new Client(server.wsUrl);
    await healthy.open();
    const hello = await healthy.waitFor("hello");
    if (hello.readOnly) await healthy.waitFor("control");
    healthy.send({ type: "input", text: "ping" });
    await healthy.waitFor("turn_end");
    assert.equal(assistantTextOf(healthy), "still here");
  } finally {
    noisy.close();
    healthy?.close();
    await server.close();
  }
});

// Reason: spec (ticket 11) — concurrent connections are bounded, and a freed
// slot lets a new client in.
test("simultaneous connections are bounded", async () => {
  const built = buildRuntime([{ text: "hi" }]);
  const server = await start(built, { maxClients: 2 });
  const a = new Client(server.wsUrl);
  const b = new Client(server.wsUrl);
  const c = new Client(server.wsUrl);
  let d: Client | undefined;
  try {
    await a.open();
    await a.waitFor("hello");
    await b.open();
    await b.waitFor("hello");

    const closed = once(c.ws, "close");
    await c.open();
    const [code] = (await closed) as [number];
    assert.equal(code, 1013);

    b.close();
    await once(b.ws, "close");
    d = new Client(server.wsUrl);
    await d.open();
    const hello = await d.waitFor("hello");
    assert.equal(hello.sessionId, built.session.id);
  } finally {
    a.close();
    b.close();
    c.close();
    d?.close();
    await server.close();
  }
});

// Reason: spec (ticket 11) — Ctrl+C must cancel the in-flight work, flush the
// log, release the lock, and leave the session resumable.
test("shutdown cancels a running turn and the log stays resumable", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-ws-"));
  const store = new JsonlSessionStore(
    mkdtempSync(join(tmpdir(), "web-store-")),
  );
  const session = store.create(workspace, "fake");
  const waitingTool = {
    definition: {
      name: "wait",
      description: "wait for cancellation",
      parameters: { type: "object", properties: {} },
    },
    annotations: { readOnlyHint: true },
    execute(call: any, ctx: any) {
      return new Promise((resolve) => {
        ctx.signal.addEventListener(
          "abort",
          () =>
            resolve({
              toolCallId: call.id,
              name: "wait",
              content: "cancelled",
              isError: true,
            }),
          { once: true },
        );
      });
    },
  };
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "w1", name: "wait", arguments: {} }] },
      { text: "after cancel" },
    ],
    { tools: [waitingTool], workspace, session },
  );
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  await client.open();
  client.send({ type: "input", text: "wait please" });
  await waitForEvent(client, "tool_call");

  await server.close();
  client.close();

  const resumed = store.resume(session.id);
  assert.ok(resumed, "lock released and log resumable");
  const userMessage = resumed.messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content[0].text, "wait please");
  const toolResult = resumed.messages.find((m) => m.role === "tool");
  assert.ok(toolResult, "the cancelled tool result was flushed");
  resumed.releaseLock();
});

// Reason: spec (ticket 11) — a huge turn cannot grow the replay buffer
// without bound; a reconnect is told the replay is partial.
test("the active-turn replay buffer is bounded", async () => {
  const provider = new BurstProvider();
  const built = buildRuntime([], { provider });
  const server = await start(built, { maxReplayBytes: 1024 });
  const a = new Client(server.wsUrl);
  let b: Client | undefined;
  try {
    await a.open();
    a.send({ type: "input", text: "burst" });
    await waitForEvent(a, "assistant_delta");

    b = new Client(server.wsUrl);
    await b.open();
    const replay = await b.waitFor("replay");
    assert.equal(replay.truncated, true);
    assert.ok(replay.events.length < 50, `buffered ${replay.events.length}`);

    provider.open();
    await a.waitFor("turn_end");
  } finally {
    a.close();
    b?.close();
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
    const result = client.messages.find(
      (m) => m.type === "event" && m.event.type === "tool_result",
    );
    assert.equal(result.event.content, "mutated");
    assert.ok(!result.event.isError);
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
    const result = client.messages.find(
      (m) => m.type === "event" && m.event.type === "tool_result",
    );
    assert.equal(result.event.content, "MUTATION_DENIED");
    assert.equal(result.event.isError, true);
    assert.match(assistantTextOf(client), /continuing after denial/);
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
      { toolCalls: [{ id: "a3", name: "mutate", arguments: {} }] },
      { text: "after reset" },
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
    assert.equal(
      client.messages.filter((m) => m.type === "approval_request").length,
      1,
    );

    // Trust belongs to the conversation, matching the terminal: a fresh
    // session asks again instead of inheriting blanket approval.
    client.send({ type: "new_session" });
    await client.waitForNext("session_changed");
    client.send({ type: "input", text: "mutate after reset" });
    const promptedAgain = await client.waitForNext("approval_request");
    assert.equal(promptedAgain.request.tool, "mutate");
    client.send({
      type: "approval",
      id: promptedAgain.id,
      turnId: promptedAgain.turnId,
      decision: "deny",
    });
    await client.waitForNext("turn_end");
    assert.deepEqual(log, ["allowed", "allowed", "denied"]);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — a browser that disappears while an approval is
// pending must not strand the turn; with nobody back before the grace period,
// the request fails safe as a denial.
test("a pending approval fails safe when the only client disconnects", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "a1", name: "mutate", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built, { approvalGraceMs: 50 });
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
    assert.equal(toolMessage.content, "MUTATION_DENIED");
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
    assert.equal(summary.messageCount, 4);
    assert.ok(summary.updatedAt);

    client.send({ type: "resume_session", id: other.id });
    const foreignError = await client.waitForNext("error");
    assert.equal(foreignError.message, "session belongs to another workspace");

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
    const historyKinds = historyMessages(resumed.history).map(
      (e: any) => e.type,
    );
    assert.deepEqual(historyKinds, [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ]);
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

// Reason: the browser sidebar can rename and delete sessions; deleting the
// active chat must open a fresh one so no client is left pointing at a gone log.
test("a session can be renamed and deleted from the browser", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake", "s1");
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  await session.flush();
  const built = buildRuntime([], { workspace, session });
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "rename_session", id: "s1", title: "Renamed chat" });
    const renamed = await client.waitForMatchingIncludingPast(
      (m) =>
        m.type === "sessions" &&
        m.sessions.some(
          (item: any) => item.id === "s1" && item.title === "Renamed chat",
        ),
    );
    assert.ok(renamed);

    client.send({
      type: "attach_file",
      id: "delete-upload",
      name: "note.txt",
      mime: "text/plain",
      data: Buffer.from("delete me", "utf8").toString("base64"),
    });
    const attached = await client.waitFor("attachment");
    assert.equal(existsSync(attached.path), true);
    const attachmentRoot = join(workspace, ".atom-lite", "attachments", "s1");
    assert.equal(existsSync(attachmentRoot), true);

    client.send({ type: "delete_session", id: "s1" });
    const changed = await client.waitForMatchingIncludingPast(
      (m) => m.type === "session_changed" && m.sessionId !== "s1",
    );
    assert.ok(changed.sessionId);
    await client.waitForMatchingIncludingPast(
      (m) =>
        m.type === "sessions" &&
        !m.sessions.some((item: any) => item.id === "s1"),
    );
    assert.equal(existsSync(join(storeRoot, "s1.jsonl")), false);
    assert.equal(
      existsSync(attachmentRoot),
      false,
      "deleting a session removes its attachment directory",
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the browser now restores thinking from the durable assistant message,
// so the text must survive a resume without relying on a client-side cache.
test("thinking is part of the durable resume history", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-think-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-think-ws-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake", "think-1");
  const built = buildRuntime([], {
    provider: new ThinkingProvider(),
    workspace,
    session,
  });
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "input", text: "think first" });
    await client.waitFor("turn_end");

    client.send({ type: "new_session" });
    await client.waitForMatchingIncludingPast(
      (message) =>
        message.type === "session_changed" && message.sessionId !== "think-1",
    );

    client.send({ type: "resume_session", id: "think-1" });
    const resumed = await client.waitForMatchingIncludingPast(
      (message) =>
        message.type === "session_changed" && message.sessionId === "think-1",
    );
    const thoughts = (resumed.history as any[])
      .filter((event) => event.type === "assistant_message")
      .map((event) => event.message?.thinking);
    assert.deepEqual(thoughts, ["Weigh the options."]);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: /model and the header picker switch the live runtime and every tab
// sees the new provider, including the next client that joins.
test("model switching updates the live runtime and broadcast state", async () => {
  const built = buildRuntime([]);
  const seen: string[] = [];
  const server = await start(built, {
    models: [
      { provider: "fake", model: "fake-model", label: "Fake" },
      { provider: "other", model: "other-model", label: "Other" },
    ],
    switchModel: (provider, model) => {
      seen.push(`${provider}/${model}`);
      return {
        provider,
        model,
        models: [{ provider, model, label: "Other" }],
      };
    },
  });
  const client = new Client(server.wsUrl);
  let second: Client | undefined;
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({
      type: "switch_model",
      provider: "other",
      model: "other-model",
    });
    const changed = await client.waitFor("model_changed");
    assert.equal(changed.provider, "other");
    assert.equal(changed.model, "other-model");
    assert.deepEqual(changed.models, [
      { provider: "other", model: "other-model", label: "Other" },
    ]);
    assert.deepEqual(seen, ["other/other-model"]);

    second = new Client(server.wsUrl);
    await second.open();
    const hello = await second.waitFor("hello");
    assert.equal(hello.provider, "other");
    assert.equal(hello.model, "other-model");
  } finally {
    client.close();
    second?.close();
    await server.close();
  }
});

// Reason: Ctrl+O opens the server directory explorer and /cwd switches the
// workspace, session scope, and runtime together.
test("the workspace explorer lists directories and switches the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-ws-a-"));
  const nextWorkspace = mkdtempSync(join(tmpdir(), "web-ws-b-"));
  mkdirSync(join(nextWorkspace, "nested"));
  const filePath = join(nextWorkspace, "not-a-dir.txt");
  writeFileSync(filePath, "x");
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "browse_directory", path: nextWorkspace });
    const directory = await client.waitFor("directory");
    assert.equal(directory.listing.path, nextWorkspace);
    assert.deepEqual(
      directory.listing.directories.map((item: any) => item.name),
      ["nested"],
    );
    assert.equal(directory.listing.parent, tmpdir());

    client.send({ type: "switch_workspace", path: nextWorkspace });
    const changed = await client.waitFor("workspace_changed");
    assert.equal(changed.workspace, nextWorkspace);
    assert.ok(changed.sessionId);

    client.send({ type: "browse_directory", path: filePath });
    const error = await client.waitFor("error");
    assert.match(error.message, /not a directory/);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the composer effort/mode chips must drive the real runtime and every
// tab sees the state; a viewer cannot change it.
test("effort and mode switch through the protocol and broadcast state", async () => {
  const built = buildRuntime([]);
  const applied: string[] = [];
  const server = await start(built, {
    mode: "yolo",
    effort: "medium",
    setMode: (mode) => applied.push(`mode:${mode}`),
    setEffort: (effort) => applied.push(`effort:${effort}`),
  });
  const client = new Client(server.wsUrl);
  let viewer: Client | undefined;
  try {
    await client.open();
    const hello = await client.waitFor("hello");
    assert.equal(hello.mode, "yolo");
    assert.equal(hello.effort, "medium");

    client.send({ type: "set_effort", effort: "high" });
    const high = await client.waitForMatchingIncludingPast(
      (m) => m.type === "runtime_state" && m.effort === "high",
    );
    assert.equal(high.mode, "yolo");

    client.send({ type: "set_mode", mode: "plan" });
    const plan = await client.waitForMatchingIncludingPast(
      (m) => m.type === "runtime_state" && m.mode === "plan",
    );
    assert.equal(plan.effort, "high");
    assert.deepEqual(applied, ["effort:high", "mode:plan"]);

    viewer = new Client(server.wsUrl);
    await viewer.open();
    const viewerHello = await viewer.waitFor("hello");
    assert.equal(viewerHello.mode, "plan");
    assert.equal(viewerHello.effort, "high");
    viewer.send({ type: "set_mode", mode: "yolo" });
    const refused = await viewer.waitFor("error");
    assert.match(refused.message, /read-only viewer/);
  } finally {
    client.close();
    viewer?.close();
    await server.close();
  }
});

// Reason: directory enumeration and provider network calls are controller
// actions, not something a read-only viewer may trigger.
test("a read-only viewer cannot browse directories or refresh models", async () => {
  const built = buildRuntime([]);
  const server = await start(built, { refreshModels: async () => [] });
  const a = new Client(server.wsUrl);
  const b = new Client(server.wsUrl);
  try {
    await a.open();
    await a.waitFor("hello");
    await b.open();
    const hello = await b.waitFor("hello");
    assert.equal(hello.readOnly, true);

    b.send({ type: "browse_directory" });
    const browseError = await b.waitForNext("error");
    assert.match(browseError.message, /read-only viewer/);

    b.send({ type: "refresh_models" });
    const refreshError = await b.waitForNext("error");
    assert.match(refreshError.message, /read-only viewer/);

    b.send({ type: "stop" });
    const stopError = await b.waitForNext("error");
    assert.match(stopError.message, /read-only viewer/);
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});

// Reason: assistant markdown can contain local images; the server serves only
// workspace images behind the run token and refuses path escapes.
test("local images are served from the workspace behind the token", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-image-ws-"));
  mkdirSync(join(workspace, "assets"));
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+G3FFAAAAAElFTkSuQmCC",
    "base64",
  );
  writeFileSync(join(workspace, "assets", "pixel.png"), pixel);
  writeFileSync(join(workspace, "notes.txt"), "not an image");
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/image", server.url);
    endpoint.searchParams.set("token", server.token);
    endpoint.searchParams.set("path", "assets/pixel.png");
    const ok = await fetch(endpoint);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^image\/png/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), pixel);

    endpoint.searchParams.set("path", "../../etc/passwd");
    assert.equal((await fetch(endpoint)).status, 404);
    endpoint.searchParams.set("path", "notes.txt");
    assert.equal((await fetch(endpoint)).status, 404);
    symlinkSync("/etc/hosts", join(workspace, "leak.png"));
    endpoint.searchParams.set("path", "leak.png");
    assert.equal(
      (await fetch(endpoint)).status,
      404,
      "a symlink cannot escape the workspace",
    );
    endpoint.searchParams.delete("token");
    endpoint.searchParams.set("path", "assets/pixel.png");
    assert.equal((await fetch(endpoint)).status, 401);
  } finally {
    await server.close();
  }
});

// Reason: /model must show live provider models, and /skills and /mcp must be
// backed by the runtime registries rather than hardcoded browser data.
test("overlay data is fetched from the runtime on demand", async () => {
  const built = buildRuntime([]);
  const server = await start(built, {
    refreshModels: async () => [
      { provider: "live", model: "live-model", label: "Live" },
    ],
    skills: () => [
      { name: "review", description: "Review changes", scope: "global" },
    ],
    mcpStatus: () => [
      {
        name: "filesystem",
        state: "ready",
        enabled: true,
        requiresApproval: false,
        toolCount: 2,
        tools: ["read", "list"],
      },
    ],
  });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "refresh_models" });
    const models = await client.waitFor("models");
    assert.deepEqual(models.models, [
      { provider: "live", model: "live-model", label: "Live" },
    ]);

    client.send({ type: "list_skills" });
    const skills = await client.waitFor("skills");
    assert.equal(skills.skills[0].name, "review");

    client.send({ type: "list_mcp" });
    const mcp = await client.waitFor("mcp");
    assert.equal(mcp.servers[0].name, "filesystem");
    assert.equal(mcp.servers[0].toolCount, 2);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: attachments are saved inside the workspace and referenced by the
// next turn so the agent's read tool can inspect them like local files.
test("attached files are saved and referenced by the next turn", async () => {
  const built = buildRuntime([{ text: "done" }]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({
      type: "attach_file",
      id: "upload-1",
      name: "notes.txt",
      mime: "text/plain",
      data: Buffer.from("hello attachment", "utf8").toString("base64"),
    });
    const attachment = await client.waitFor("attachment");
    assert.equal(attachment.id, "upload-1");
    assert.match(attachment.name, /^notes\.txt$/);
    assert.ok(attachment.path.includes(built.workspace));
    assert.equal(attachment.size, 16);

    client.send({ type: "input", text: "read the attachment" });
    await client.waitFor("turn_end");
    const user = built.session.events.find(
      (event) => event.type === "user_message",
    );
    assert.match(JSON.stringify(user), /Attached local files/);
    assert.match(JSON.stringify(user), /notes\.txt/);

    client.send({ type: "remove_attachment", path: attachment.path });
    const removed = await client.waitFor("attachment_removed");
    assert.equal(removed.path, attachment.path);
    assert.equal(existsSync(attachment.path), false);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the browser task panel is fed by live runtime ledger events and by
// the durable session log after a reconnect; both must expose the same latest
// snapshot so the panel never invents or loses tasks.
test("todo ledger reaches the browser and survives reconnect history", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake", "todo-1");
  const built = buildRuntime([], {
    provider: new FakeProvider([
      {
        toolCalls: [
          {
            id: "todo-1",
            name: "todo",
            arguments: {
              action: "write",
              todos: [
                { content: "ship the task panel", status: "in_progress" },
              ],
            },
          },
        ],
      },
      { text: "done" },
    ]),
    tools: [todoTool],
    workspace,
    session,
  });
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");
    client.send({ type: "input", text: "plan the work" });
    await client.waitFor("turn_end");

    const ledger = client.messages.find(
      (message) =>
        message.type === "event" && message.event.type === "ledger_state",
    );
    assert.ok(ledger, "ledger_state is broadcast to the browser");
    assert.equal(ledger.event.open, 1);
    assert.equal(ledger.event.todos[0].content, "ship the task panel");

    const durable = built.session.events.filter(
      (event: any) => event.type === "todos_updated",
    );
    assert.equal(durable.length, 1);
    assert.deepEqual(durable[0].todos, ledger.event.todos);

    const second = new Client(server.wsUrl);
    await second.open();
    const hello = await second.waitFor("hello");
    const historyEvent = hello.history.find(
      (event: any) => event.type === "todos_updated",
    );
    assert.ok(historyEvent, "the durable ledger is in hello history");
    assert.equal(historyEvent.todos[0].content, "ship the task panel");
    second.close();
  } finally {
    client.close();
    await server.close();
  }
});
