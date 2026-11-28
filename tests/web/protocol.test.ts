import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { WebSocket } from "ws";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { todoTool } from "../../dist/tools/todo.js";
import { questionTool } from "../../dist/tools/question.js";
import { checkApproval } from "../../dist/runtime/approvals.js";
import {
  InMemorySession,
  JsonlSessionStore,
  type Session,
} from "../../dist/sessions/store.js";
import { startWebServer, webThemeFor } from "../../dist/web/server.js";
import { parseClientMessage } from "../../dist/web/protocol.js";
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
  questions?: any;
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
    questions: options.questions,
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
    agent?: string | null;
    agents?: (workspace: string) => any[];
    switchAgent?: (name: string, workspace: string) => any;
    mode?: "plan" | "yolo";
    effort?: string;
    setMode?: (mode: "plan" | "yolo") => void;
    setEffort?: (effort: string) => void;
    refreshModels?: () => Promise<any[]>;
    skills?: () => any[];
    mcpStatus?: () => any[];
    setMcpEnabled?: (name: string, enabled: boolean) => any;
    questions?: any;
    pickDirectory?: () => Promise<string | null>;
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
    agent: extras.agent,
    agents: extras.agents,
    switchAgent: extras.switchAgent,
    mode: extras.mode,
    effort: extras.effort,
    setMode: extras.setMode,
    setEffort: extras.setEffort,
    refreshModels: extras.refreshModels,
    skills: extras.skills,
    mcpStatus: extras.mcpStatus,
    setMcpEnabled: extras.setMcpEnabled,
    questions: extras.questions,
    pickDirectory: extras.pickDirectory,
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
    assert.equal(typeof hello.nativePicker, "boolean");

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

// Reason: spec (right workbench) — the file tree and the @ picker both read
// one directory at a time, with dirs first and natural case-insensitive order.
test("the workspace tree lists directories first in natural order", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-tree-ws-"));
  mkdirSync(join(workspace, "src"));
  mkdirSync(join(workspace, "assets"));
  mkdirSync(join(workspace, "Zed"));
  writeFileSync(join(workspace, "app.ts"), "const x = 1;\n");
  writeFileSync(join(workspace, "App2.ts"), "two");
  writeFileSync(join(workspace, "app10.ts"), "ten");
  writeFileSync(join(workspace, "src", "nested.ts"), "nested");
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/tree", server.url);
    endpoint.searchParams.set("token", server.token);
    const root = await (await fetch(endpoint)).json();
    assert.equal(root.path, "");
    assert.equal(root.parent, null);
    assert.deepEqual(
      root.entries.map((entry: any) => entry.name),
      ["assets", "src", "Zed", "app.ts", "App2.ts", "app10.ts"],
    );
    assert.deepEqual(
      root.entries.map((entry: any) => entry.type),
      ["dir", "dir", "dir", "file", "file", "file"],
    );
    assert.deepEqual(root.entries[3], {
      name: "app.ts",
      path: "app.ts",
      type: "file",
      size: 13,
    });
    assert.equal("size" in root.entries[0], false);
    assert.equal(root.truncated, false);

    endpoint.searchParams.set("path", "src");
    const nested = await (await fetch(endpoint)).json();
    assert.equal(nested.path, "src");
    assert.equal(nested.parent, null);
    assert.deepEqual(nested.entries, [
      { name: "nested.ts", path: "src/nested.ts", type: "file", size: 6 },
    ]);
  } finally {
    await server.close();
  }
});

// Reason: the tree is the browser's view into the workspace, so every escape
// and guard must hold there too, and huge directories must be bound before a
// browser can enumerate them.
test("the workspace tree is token-guarded, contained, and bounded", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-tree-guard-ws-"));
  mkdirSync(join(workspace, "small"));
  writeFileSync(join(workspace, "small", "a.txt"), "a");
  mkdirSync(join(workspace, "many"));
  for (let index = 0; index < 505; index += 1) {
    writeFileSync(join(workspace, "many", `f${index}.txt`), "x");
  }
  for (let dir = 0; dir < 11; dir += 1) {
    const name = `bulk${dir}`;
    mkdirSync(join(workspace, name));
    for (let index = 0; index < 460; index += 1) {
      writeFileSync(join(workspace, name, `${index}.txt`), "x");
    }
  }
  symlinkSync("/etc/hosts", join(workspace, "leak.txt"));
  symlinkSync("/etc", join(workspace, "leak-dir"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/tree", server.url);
    endpoint.searchParams.set("token", server.token);

    endpoint.searchParams.set("path", "many");
    const many = await (await fetch(endpoint)).json();
    assert.equal(many.entries.length, 500);
    assert.equal(many.truncated, true);

    endpoint.searchParams.set("path", "");
    const root = await (await fetch(endpoint)).json();
    assert.equal(
      root.entries.some((entry: any) => entry.name.startsWith("leak")),
      false,
    );
    for (const path of [
      "leak.txt",
      "leak-dir",
      "../../etc",
      "a".repeat(5000),
      "small/a.txt",
    ]) {
      endpoint.searchParams.set("path", path);
      assert.equal((await fetch(endpoint)).status, 404, `path ${path}`);
    }

    endpoint.searchParams.delete("token");
    endpoint.searchParams.set("path", "small");
    assert.equal((await fetch(endpoint)).status, 401);
    endpoint.searchParams.set("token", server.token);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `/tree?path=small&token=${server.token}`,
      ),
      403,
    );

    endpoint.searchParams.set("path", "");
    endpoint.searchParams.set("recursive", "1");
    const recursive = await (await fetch(endpoint)).json();
    assert.equal(recursive.entries.length, 5000);
    assert.equal(recursive.truncated, true);
  } finally {
    await server.close();
  }
});

// Reason: the file tab streams workspace bytes into the browser, so the
// endpoint must harden the response and never turn a workspace file into an
// active document or a local arbitrary-read primitive.
test("workspace files are served with revisions and hardened headers", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-file-ws-"));
  mkdirSync(join(workspace, "assets"));
  const source = "export const answer = 42;\n";
  const html = "<script>alert(1)</script>";
  const svg = '<svg onload="alert(1)"></svg>';
  const pdf = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n";
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+G3FFAAAAAElFTkSuQmCC",
    "base64",
  );
  writeFileSync(join(workspace, "src.ts"), source);
  writeFileSync(join(workspace, "page.html"), html);
  writeFileSync(join(workspace, "icon.svg"), svg);
  writeFileSync(join(workspace, "report.pdf"), pdf);
  writeFileSync(join(workspace, "assets", "pixel.png"), pixel);
  writeFileSync(join(workspace, ".env"), "TOKEN=local\n");
  writeFileSync(join(workspace, "app.lock"), "lock\n");
  writeFileSync(join(workspace, "binary.exe"), "MZ");
  writeFileSync(
    join(workspace, "huge.txt"),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  );
  symlinkSync("/etc/hosts", join(workspace, "leak.txt"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/file", server.url);
    endpoint.searchParams.set("token", server.token);
    endpoint.searchParams.set("path", "src.ts");
    const ok = await fetch(endpoint);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), source);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(Number(ok.headers.get("content-length")), source.length);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      ok.headers.get("content-security-policy"),
      "default-src 'none'",
    );
    assert.equal(
      ok.headers.get("x-file-revision"),
      createHash("sha256").update(source).digest("hex"),
    );

    for (const [name, expected] of [
      ["page.html", html],
      ["icon.svg", svg],
    ]) {
      endpoint.searchParams.set("path", name);
      const response = await fetch(endpoint);
      assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await response.text(), expected);
    }
    endpoint.searchParams.set("path", "report.pdf");
    assert.match(
      (await fetch(endpoint)).headers.get("content-type") ?? "",
      /^application\/pdf/,
    );
    endpoint.searchParams.set("path", "assets/pixel.png");
    const image = await fetch(endpoint);
    assert.match(image.headers.get("content-type") ?? "", /^image\/png/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), pixel);

    for (const path of [".env", "app.lock"]) {
      endpoint.searchParams.set("path", path);
      const response = await fetch(endpoint);
      assert.equal(response.status, 200, `path ${path}`);
      assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    }

    for (const path of [
      "binary.exe",
      "huge.txt",
      "missing.txt",
      "leak.txt",
      "../../etc/passwd",
      "assets",
      "a".repeat(5000),
    ]) {
      endpoint.searchParams.set("path", path);
      assert.notEqual((await fetch(endpoint)).status, 200, `path ${path}`);
    }

    endpoint.searchParams.set("path", "src.ts");
    endpoint.searchParams.delete("token");
    assert.equal((await fetch(endpoint)).status, 401);
    endpoint.searchParams.set("token", server.token);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `/file?path=src.ts&token=${server.token}`,
      ),
      403,
    );
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 01) — the video and audio previews read bytes from a
// separate bounded endpoint. It must share the token, origin, host, containment
// and extension guards, stream only known media types, and stay inert if a
// browser opens the response directly.
test("workspace media streams only allowlisted guarded files", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-media-ws-"));
  const clip = Buffer.from("0123456789abcdef");
  writeFileSync(join(workspace, "clip.mp4"), clip);
  const formats: Array<[string, string]> = [
    ["movie.webm", "video/webm"],
    ["old.mov", "video/quicktime"],
    ["film.mkv", "video/x-matroska"],
    ["tape.avi", "video/x-msvideo"],
    ["film.mpeg", "video/mpeg"],
    ["tone.mp3", "audio/mpeg"],
    ["sound.wav", "audio/wav"],
    ["note.ogg", "audio/ogg"],
    ["track.m4a", "audio/mp4"],
  ];
  for (const [name] of formats) writeFileSync(join(workspace, name), clip);
  writeFileSync(join(workspace, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(workspace, "icon.svg"), "<svg onload='alert(1)'/>");
  writeFileSync(join(workspace, "notes.txt"), "plain text");
  symlinkSync("/etc/hosts", join(workspace, "leak.mp4"));
  writeFileSync(join(workspace, "huge.mp4"), "");
  truncateSync(join(workspace, "huge.mp4"), 256 * 1024 * 1024 + 1);
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/media", server.url);
    endpoint.searchParams.set("token", server.token);
    endpoint.searchParams.set("path", "clip.mp4");
    const ok = await fetch(endpoint);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^video\/mp4/);
    assert.equal(Number(ok.headers.get("content-length")), clip.length);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), clip);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      ok.headers.get("content-security-policy") ?? "",
      /default-src 'none'.*sandbox/,
    );
    assert.equal(ok.headers.get("accept-ranges"), "bytes");
    assert.match(ok.headers.get("etag") ?? "", /^W\//);
    assert.ok(ok.headers.get("last-modified"));

    for (const [name, mime] of formats) {
      endpoint.searchParams.set("path", name);
      const response = await fetch(endpoint);
      assert.equal(response.status, 200, `path ${name}`);
      assert.equal(
        response.headers.get("content-type"),
        mime,
        `MIME for ${name}`,
      );
      await response.arrayBuffer();
    }

    for (const path of [
      "page.html",
      "icon.svg",
      "notes.txt",
      "leak.mp4",
      "../../etc/passwd",
      "missing.mp4",
      "a".repeat(5000),
    ]) {
      endpoint.searchParams.set("path", path);
      assert.notEqual((await fetch(endpoint)).status, 200, `path ${path}`);
    }
    endpoint.searchParams.set("path", "huge.mp4");
    assert.equal((await fetch(endpoint)).status, 413, "streaming cap");

    endpoint.searchParams.set("path", "clip.mp4");
    endpoint.searchParams.delete("token");
    assert.equal((await fetch(endpoint)).status, 401);
    endpoint.searchParams.set("token", server.token);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `/media?path=clip.mp4&token=${server.token}`,
      ),
      403,
    );
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 01) — a media element seeks with byte ranges. The
// response must advertise partial content, clip open-ended ranges, reject
// impossible ones with 416, and keep validators on partial responses.
test("media byte ranges negotiate 206 and 416 with validators", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-range-ws-"));
  const clip = Buffer.from("0123456789abcdef");
  writeFileSync(join(workspace, "clip.mp4"), clip);
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/media", server.url);
    endpoint.searchParams.set("token", server.token);
    endpoint.searchParams.set("path", "clip.mp4");

    const full = await fetch(endpoint);
    assert.equal(full.status, 200);
    const etag = full.headers.get("etag")!;
    await full.arrayBuffer();

    const partial = await fetch(endpoint, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(Number(partial.headers.get("content-length")), 4);
    assert.equal(partial.headers.get("etag"), etag);
    assert.equal(await partial.text(), "2345");

    const openEnded = await fetch(endpoint, {
      headers: { Range: "bytes=12-" },
    });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers.get("content-range"), "bytes 12-15/16");
    assert.equal(await openEnded.text(), "cdef");

    const suffix = await fetch(endpoint, { headers: { Range: "bytes=-4" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 12-15/16");
    assert.equal(await suffix.text(), "cdef");

    const clipped = await fetch(endpoint, {
      headers: { Range: "bytes=10-99" },
    });
    assert.equal(clipped.status, 206);
    assert.equal(clipped.headers.get("content-range"), "bytes 10-15/16");
    assert.equal(await clipped.text(), "abcdef");

    for (const range of ["bytes=16-", "bytes=5-2", "bytes=-0"]) {
      const invalid = await fetch(endpoint, { headers: { Range: range } });
      assert.equal(invalid.status, 416, `range ${range}`);
      assert.equal(invalid.headers.get("content-range"), "bytes */16");
      assert.equal(invalid.headers.get("accept-ranges"), "bytes");
    }

    const notModified = await fetch(endpoint, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.get("etag"), etag);

    const staleRange = await fetch(endpoint, {
      headers: { Range: "bytes=2-5", "If-Range": '"stale"' },
    });
    assert.equal(staleRange.status, 200, "a stale If-Range ignores the range");
    assert.equal(await staleRange.text(), "0123456789abcdef");
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 01) — Office engines load lazily from this same origin.
// The route serves only allowlisted files from the pinned packages, with the
// correct module and WASM types, and never bypasses the existing guards.
test("office engine assets are served from a strict same-origin allowlist", async () => {
  const built = buildRuntime([]);
  const server = await start(built);
  try {
    const endpoint = new URL(
      "/engine/@betteroffice/xlsx/dist/index.js",
      server.url,
    );
    endpoint.searchParams.set("token", server.token);
    const module = await fetch(endpoint);
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") ?? "", /javascript/);
    assert.equal(module.headers.get("cache-control"), "no-store");
    assert.equal(module.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await module.text()).length > 0);

    const wasm = await fetch(
      new URL(
        `/engine/@betteroffice/pptx/dist/generated/pptx_wasm_bg.wasm?token=${server.token}`,
        server.url,
      ),
    );
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    await wasm.arrayBuffer();

    const esm = await fetch(
      new URL(
        `/engine/@betteroffice/docx/dist/core.mjs?token=${server.token}`,
        server.url,
      ),
    );
    assert.equal(esm.status, 200);
    assert.match(esm.headers.get("content-type") ?? "", /javascript/);

    for (const path of [
      "/engine/evil/index.js",
      "/engine/@betteroffice/xlsx/package.json",
      "/engine/@betteroffice/xlsx/%2e%2e%2f%2e%2e%2fpackage.json",
      "/engine/@betteroffice/xlsx/dist/missing.js",
    ]) {
      assert.notEqual(
        (await fetch(new URL(`${path}&token=${server.token}`, server.url)))
          .status,
        200,
        `asset ${path}`,
      );
    }

    assert.equal(
      (await fetch(new URL(endpoint.pathname, server.url))).status,
      401,
    );
    assert.equal(
      (await fetch(endpoint, { headers: { Origin: "http://evil.example" } }))
        .status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `${endpoint.pathname}?token=${server.token}`,
      ),
      403,
    );
  } finally {
    await server.close();
  }
});

// Reason: the Review tab renders workspace changes, so the diff endpoint must
// return real hunks behind the same token and origin guards as file reads.
test("the workspace diff returns real hunks behind the token", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-diff-ws-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  writeFileSync(join(workspace, "app.ts"), "one\ntwo\nthree\n");
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "initial");
  writeFileSync(join(workspace, "app.ts"), "one\nTWO\nthree\nfour\n");
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/diff", server.url);
    endpoint.searchParams.set("token", server.token);
    const diff = await (await fetch(endpoint)).json();
    assert.equal(diff.truncated, false);
    assert.equal(diff.entries.length, 1);
    const entry = diff.entries[0];
    assert.equal(entry.path, "app.ts");
    assert.equal(entry.added, 2);
    assert.equal(entry.deleted, 1);
    assert.equal(entry.summary, "+2 -1");
    assert.equal(entry.hunks.length, 1);
    assert.match(entry.hunks[0].header, /^@@/);
    assert.deepEqual(
      entry.hunks[0].lines.filter((line: any) => line.type !== "context"),
      [
        { type: "del", text: "two" },
        { type: "add", text: "TWO" },
        { type: "add", text: "four" },
      ],
    );
    assert.equal(
      entry.hunks[0].lines.some((line: any) => line.text === "one"),
      true,
    );

    endpoint.searchParams.delete("token");
    assert.equal((await fetch(endpoint)).status, 401);
    endpoint.searchParams.set("token", server.token);
    assert.equal(
      (
        await fetch(endpoint, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `/diff?token=${server.token}`,
      ),
      403,
    );

    const emptyWorkspace = mkdtempSync(join(tmpdir(), "web-diff-empty-ws-"));
    const emptyServer = await start(
      buildRuntime([], { workspace: emptyWorkspace }),
    );
    try {
      const emptyEndpoint = new URL("/diff", emptyServer.url);
      emptyEndpoint.searchParams.set("token", emptyServer.token);
      const empty = await (await fetch(emptyEndpoint)).json();
      assert.deepEqual(empty, { entries: [], truncated: false });
    } finally {
      await emptyServer.close();
    }
  } finally {
    await server.close();
  }
});

// Reason: a huge change must not stall the Review tab, so both the file count
// and the line count are capped and reported as truncation.
test("the workspace diff caps files and lines", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-diff-caps-ws-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  const files = 205;
  for (let index = 0; index < files; index += 1) {
    writeFileSync(join(workspace, `file${index}.txt`), "old\n");
  }
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "initial");
  for (let index = 0; index < files; index += 1) {
    const changed =
      index === 0
        ? Array.from({ length: 20_500 }, (_, line) => `line ${line}`).join("\n")
        : "new\n";
    writeFileSync(join(workspace, `file${index}.txt`), changed);
  }
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const endpoint = new URL("/diff", server.url);
    endpoint.searchParams.set("token", server.token);
    const diff = await (await fetch(endpoint)).json();
    assert.equal(diff.truncated, true);
    assert.ok(diff.entries.length <= 200);
    const lines = diff.entries.reduce(
      (total: number, entry: any) =>
        total +
        entry.hunks.reduce(
          (sum: number, hunk: any) => sum + hunk.lines.length,
          0,
        ),
      0,
    );
    assert.ok(lines <= 20_000);
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

// Reason: the browser agent overlay offers primary personas and must never
// switch the runtime persona under a running turn.
test("agent profiles list and switch only between turns", async () => {
  const catalog = [
    { name: "default", description: "Default", source: "bundled" },
    { name: "reviewer", description: "Code reviewer", source: "bundled" },
  ];
  let active = "default";
  const provider = new GatedProvider();
  const built = buildRuntime([], { provider });
  const server = await start(built, {
    agent: active,
    agents: () => catalog,
    switchAgent: (name: string) => {
      if (!catalog.some((agent) => agent.name === name)) {
        return { error: `unknown agent: ${name}` };
      }
      active = name;
      return { agent: name, agents: catalog };
    },
  });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const hello = await client.waitFor("hello");
    assert.equal(hello.agent, "default");
    assert.deepEqual(
      hello.agents.map((agent: any) => agent.name),
      ["default", "reviewer"],
    );

    client.send({ type: "list_agents" });
    const listed = await client.waitFor("agents");
    assert.equal(listed.active, "default");
    assert.equal(listed.agents.length, 2);

    client.send({ type: "switch_agent", name: "reviewer" });
    const changed = await client.waitForNext("agent_changed");
    assert.equal(changed.agent, "reviewer");
    assert.equal(active, "reviewer");

    client.send({ type: "input", text: "hold the turn" });
    await client.waitForNext("turn_start");
    client.send({ type: "switch_agent", name: "default" });
    const error = await client.waitForNext("error");
    assert.match(error.message, /cannot switch agent while a turn is running/);
    assert.equal(active, "reviewer");

    provider.open();
    await client.waitForNext("turn_end");
    client.send({ type: "switch_agent", name: "default" });
    const back = await client.waitForNext("agent_changed");
    assert.equal(back.agent, "default");
    assert.equal(active, "default");
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the footer workspace path opens the host OS folder picker; only a
// real selection switches the workspace, and cancel is a quiet no-op.
test("the native workspace picker switches and cancels cleanly", async () => {
  const target = mkdtempSync(join(tmpdir(), "web-picked-"));
  let next: string | null = target;
  const built = buildRuntime([]);
  const server = await start(built, {
    pickDirectory: async () => next,
  });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const hello = await client.waitFor("hello");

    client.send({ type: "pick_workspace" });
    const changed = await client.waitFor("workspace_changed");
    assert.equal(changed.workspace, target);
    assert.notEqual(changed.sessionId, hello.sessionId);

    next = null;
    client.send({ type: "pick_workspace" });
    await client.waitFor("workspace_pick_cancelled");
    assert.equal(
      client.messages.filter((message) => message.type === "workspace_changed")
        .length,
      1,
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the question tool blocks the runtime on a browser answer; the reply
// must flow back into the exact model-facing projection.
test("question requests are answered from the browser", async () => {
  const questions = { handler: undefined, nonInteractive: true };
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "q1",
          name: "question",
          arguments: {
            questions: [
              {
                question: "Which color?",
                header: "Color",
                options: [
                  { label: "Blue", description: "Cool" },
                  { label: "Red", description: "Warm" },
                ],
              },
            ],
          },
        },
      ],
    },
    { text: "done" },
  ]);
  const built = buildRuntime([], {
    provider,
    tools: [questionTool],
    questions,
  });
  const server = await start(built, { questions });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");
    client.send({ type: "input", text: "ask me" });
    const request = await client.waitFor("question_request");
    assert.equal(request.questions[0].header, "Color");
    assert.equal(request.questions[0].options.length, 2);

    client.send({
      type: "question_response",
      id: request.id,
      answers: [["Blue"]],
    });
    await client.waitFor("question_resolved");
    await client.waitFor("turn_end");

    const result = built.session.events.find(
      (event: any) => event.type === "tool_result",
    );
    assert.match(result.content, /"Which color\?"="Blue"/);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: dismissing a browser question is a typed dismissal that stops the
// step instead of feeding an invented answer back to the model.
test("dismissing a browser question stops the turn", async () => {
  const questions = { handler: undefined, nonInteractive: true };
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "q2",
          name: "question",
          arguments: {
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [{ label: "Yes", description: "Proceed" }],
              },
            ],
          },
        },
      ],
    },
    { text: "should not be used" },
  ]);
  const built = buildRuntime([], {
    provider,
    tools: [questionTool],
    questions,
  });
  const server = await start(built, { questions });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");
    client.send({ type: "input", text: "ask me" });
    const request = await client.waitFor("question_request");
    client.send({ type: "question_dismiss", id: request.id });
    await client.waitFor("question_resolved");
    await client.waitFor("turn_end");

    const result = built.session.events.find(
      (event: any) => event.type === "tool_result",
    );
    assert.equal(result.content, "The user dismissed this question");
    assert.ok(
      !built.session.events.some(
        (event: any) =>
          event.type === "assistant_message" &&
          JSON.stringify(event).includes("should not be used"),
      ),
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: the web MCP overlay connects and disconnects a configured server and
// broadcasts the refreshed status to every tab.
test("mcp servers connect and disconnect from the browser", async () => {
  let servers = [
    {
      name: "fs",
      state: "disabled",
      enabled: false,
      requiresApproval: false,
      toolCount: 0,
      tools: [],
    },
  ];
  const built = buildRuntime([]);
  const server = await start(built, {
    mcpStatus: () => servers,
    setMcpEnabled: (name: string, enabled: boolean) => {
      if (name !== "fs") throw new Error(`Unknown MCP server: ${name}`);
      servers = [
        {
          ...servers[0],
          enabled,
          state: enabled ? "ready" : "disabled",
          toolCount: enabled ? 1 : 0,
          tools: enabled ? ["mcp__fs__read"] : [],
        },
      ];
      return servers;
    },
  });
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");

    client.send({ type: "list_mcp" });
    const before = await client.waitFor("mcp");
    assert.equal(before.servers[0].state, "disabled");

    client.send({ type: "set_mcp_enabled", name: "fs", enabled: true });
    const connected = await client.waitForNext("mcp");
    assert.equal(connected.servers[0].state, "ready");
    assert.equal(connected.servers[0].toolCount, 1);

    client.send({ type: "set_mcp_enabled", name: "fs", enabled: false });
    const disconnected = await client.waitForNext("mcp");
    assert.equal(disconnected.servers[0].state, "disabled");
    assert.equal(disconnected.servers[0].toolCount, 0);
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

// Reason: spec — browser goal state must match TUI and survive resume. The
// mutators write durable goal_updated events and broadcast goal_state events.
test("goal mutators are live and durable over the browser protocol", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "web-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "web-workspace-"));
  const store = new JsonlSessionStore(storeRoot);
  const session = store.create(workspace, "fake", "goal-1");
  // A message makes the log durable, so later goal events are written too.
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "seed the session" }],
  });
  await session.flush();
  const built = buildRuntime([], { workspace, session });
  const server = await start(built, { store });
  const client = new Client(server.wsUrl);
  let second: Client | undefined;
  try {
    await client.open();
    await client.waitFor("hello");

    const expectGoal = (predicate: (goal: any) => boolean) =>
      client.waitForMatching(
        (m) =>
          m.type === "event" &&
          m.event.type === "goal_state" &&
          predicate(m.event.goal),
        3000,
      );

    let pending = expectGoal((g) => g?.statement === "Ship parity");
    client.send({ type: "set_goal", statement: "Ship parity" });
    const stated = await pending;
    assert.equal(stated.event.goal.status, "active");

    pending = expectGoal((g) => g?.criteria?.length === 2);
    client.send({
      type: "set_goal_criteria",
      criteria: ["tests pass", "docs updated"],
    });
    const withCriteria = await pending;
    assert.deepEqual(withCriteria.event.goal.criteria, [
      "tests pass",
      "docs updated",
    ]);
    assert.equal(withCriteria.event.goal.statement, "Ship parity");

    pending = expectGoal((g) => g?.constraints === "no new deps");
    client.send({ type: "set_goal_constraints", constraints: "no new deps" });
    const withConstraints = await pending;
    assert.equal(withConstraints.event.goal.statement, "Ship parity");

    pending = expectGoal((g) => g?.status === "paused");
    client.send({ type: "goal_action", action: "pause" });
    const paused = await pending;
    assert.equal(paused.event.goal.statement, "Ship parity");

    pending = expectGoal((g) => g?.status === "active");
    client.send({ type: "goal_action", action: "resume" });
    const afterResume = await pending;
    assert.equal(afterResume.event.goal.constraints, "no new deps");

    await session.flush();
    const durable = session.events.filter(
      (event: any) => event.type === "goal_updated",
    );
    assert.equal(durable.length, 5);
    const last = durable.at(-1) as any;
    assert.equal(last.goal.statement, "Ship parity");
    assert.deepEqual(last.goal.criteria, ["tests pass", "docs updated"]);
    assert.equal(last.goal.constraints, "no new deps");
    assert.equal(last.goal.status, "active");

    second = new Client(server.wsUrl);
    await second.open();
    const hello = await second.waitFor("hello");
    assert.ok(hello.goal, "hello carries the goal snapshot");
    assert.equal(hello.goal.statement, "Ship parity");
    assert.deepEqual(hello.goal.criteria, ["tests pass", "docs updated"]);
    assert.equal(hello.goal.constraints, "no new deps");
    assert.equal(hello.goal.status, "active");
    second.close();
    second = undefined;

    client.send({ type: "new_session" });
    const fresh = await client.waitForNext("session_changed");
    assert.equal(fresh.goal, null);

    client.send({ type: "resume_session", id: session.id });
    const restored = await client.waitForNext("session_changed");
    assert.equal(restored.sessionId, session.id);
    assert.ok(restored.goal, "session_changed carries the goal snapshot");
    assert.equal(restored.goal.statement, "Ship parity");
    assert.deepEqual(restored.goal.criteria, ["tests pass", "docs updated"]);
    assert.equal(restored.goal.constraints, "no new deps");
    assert.equal(restored.goal.status, "active");
  } finally {
    second?.close();
    client.close();
    await server.close();
  }
});

// Reason: spec — goal mutators widen the controller-only authorization surface.
test("goal mutators are refused for viewers and while a turn runs", async () => {
  const log: string[] = [];
  const built = buildRuntime(
    [
      { toolCalls: [{ id: "g1", name: "mutate", arguments: {} }] },
      { text: "done" },
    ],
    { tools: [mutatingTool(log)] },
  );
  const server = await start(built);
  const controller = new Client(server.wsUrl);
  let viewer: Client | undefined;
  try {
    await controller.open();
    await controller.waitFor("hello");

    viewer = new Client(server.wsUrl);
    await viewer.open();
    await viewer.waitFor("hello");
    const viewerRefusal = viewer.waitFor("error");
    viewer.send({ type: "set_goal", statement: "viewer must not set" });
    const refused = await viewerRefusal;
    assert.match(refused.message, /read-only viewer/);
    assert.equal(built.runtime.getGoal(), null);

    controller.send({ type: "input", text: "mutate please" });
    const request = await controller.waitFor("approval_request");
    assert.ok(request.turnId > 0);
    const turnRefusal = controller.waitForNext("error");
    controller.send({ type: "set_goal", statement: "mid-turn must not set" });
    const duringTurn = await turnRefusal;
    assert.match(duringTurn.message, /while a turn is running/);
    assert.equal(built.runtime.getGoal(), null);

    controller.send({
      type: "approval",
      id: request.id,
      turnId: request.turnId,
      decision: "approve",
    });
    await controller.waitFor("turn_end");
  } finally {
    controller.close();
    viewer?.close();
    await server.close();
  }
});

// Reason: regression — compaction was invisible on the web surface. The server
// broadcasts every AgentEvent; this proves the compaction fields pass through
// unchanged and no summary or native payload is added.
test("compaction events pass through to the browser without summary text", async () => {
  const built = buildRuntime([]);
  let sink: ((event: any) => void) | undefined;
  const originalSetSink = built.runtime.setEventSink.bind(built.runtime);
  built.runtime.setEventSink = (handler) => {
    sink = handler as ((event: any) => void) | undefined;
    originalSetSink(handler);
  };
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await client.waitFor("hello");
    assert.ok(sink, "the server installed an event sink");
    const emit = sink as (event: any) => void;

    const started = {
      type: "context_compaction_started",
      model: "m",
      strategy: "summary",
    };
    const startedWait = client.waitForMatching(
      (m) =>
        m.type === "event" && m.event.type === "context_compaction_started",
    );
    emit(started);
    const startedMessage = await startedWait;
    assert.deepEqual(startedMessage.event, started);

    const failed = {
      type: "context_compaction_failed",
      model: "m",
      strategy: "summary",
      reason: "boom",
    };
    const failedWait = client.waitForMatching(
      (m) => m.type === "event" && m.event.type === "context_compaction_failed",
    );
    emit(failed);
    const failedMessage = await failedWait;
    assert.deepEqual(failedMessage.event, failed);

    // The continuation is the success signal the browser clears the notice on.
    const continuation = { type: "compaction_continuation", text: "continue" };
    const continuationWait = client.waitForMatching(
      (m) => m.type === "event" && m.event.type === "compaction_continuation",
    );
    emit(continuation);
    const continuationMessage = await continuationWait;
    assert.deepEqual(continuationMessage.event, continuation);

    for (const message of client.messages) {
      if (message.type !== "event") continue;
      if (
        message.event.type !== "context_compaction_started" &&
        message.event.type !== "context_compaction_failed"
      ) {
        continue;
      }
      assert.ok(
        !("text" in message.event) && !("summary" in message.event),
        "compaction status events carry no summary or native payload",
      );
    }
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (turn stats) — the browser shows real elapsed time and token
// throughput; the numbers come from the runtime's measured provider calls.
test("turn_end reports measured duration, output tokens, and model time", async () => {
  const built = buildRuntime([], {
    provider: new FakeProvider([
      { text: "done", usage: { input: 20, output: 42 } },
    ]),
  });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const hello = await client.waitFor("hello");
    assert.deepEqual(hello.context, {
      tokens: null,
      contextWindow: null,
      percent: null,
    });

    client.send({ type: "input", text: "go" });
    const end = await client.waitFor("turn_end");
    assert.equal(typeof end.elapsedMs, "number");
    assert.ok(end.elapsedMs >= 0);
    assert.equal(end.outputTokens, 42);
    assert.equal(typeof end.modelMs, "number");
    assert.ok(end.modelMs >= 0);

    // A client that connects after the turn gets the real occupancy, not a
    // placeholder: input 20 + output 42 tokens for the latest step.
    const second = new Client(server.wsUrl);
    await second.open();
    const after = await second.waitFor("hello");
    assert.deepEqual(after.context, {
      used: 62,
      tokens: 62,
      contextWindow: null,
      percent: null,
    });
    second.close();
  } finally {
    client.close();
    await server.close();
  }
});

async function putFile(
  server: Awaited<ReturnType<typeof start>>,
  path: string,
  body: { revision: string; content: string },
  headers: Record<string, string> = {},
): Promise<Response> {
  const endpoint = new URL("/file", server.url);
  endpoint.searchParams.set("token", server.token);
  endpoint.searchParams.set("path", path);
  return fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function openTerminal(
  client: Client,
  id: string,
  cols = 80,
  rows = 24,
): Promise<void> {
  client.send({ type: "terminal_open", id, cols, rows });
  const request = await client.waitForNext("approval_request");
  client.send({ type: "approval", id: request.id, decision: "approve" });
  const started = await client.waitForMatching(
    (message) => message.type === "terminal_started" && message.id === id,
  );
  assert.equal(started.id, id);
}

function terminalOutput(client: Client, id: string, text: string) {
  return client.waitForMatching(
    (message) =>
      message.type === "terminal_output" &&
      message.id === id &&
      message.data.includes(text),
  );
}

function terminalExit(client: Client, id: string) {
  return client.waitForMatching(
    (message) => message.type === "terminal_exited" && message.id === id,
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Reason: spec (ticket 03) — a file tab saves against the revision it loaded,
// and the same boundary that guards reads must guard writes.
test("a file save checks revision, path, token, and size", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-put-ws-"));
  const source = "first\n";
  writeFileSync(join(workspace, "note.txt"), source);
  writeFileSync(join(workspace, "blob.exe"), "MZ");
  symlinkSync("/etc/hosts", join(workspace, "leak.txt"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  try {
    const revision = sha256(source);
    const saved = await putFile(server, "note.txt", {
      revision,
      content: "second\n",
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { revision: sha256("second\n") });
    assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "second\n");

    const stale = await putFile(server, "note.txt", {
      revision,
      content: "stale\n",
    });
    assert.equal(stale.status, 409);
    assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "second\n");

    for (const path of [
      "blob.exe",
      "leak.txt",
      "../../etc/passwd",
      "missing.txt",
      "a".repeat(5000),
    ]) {
      const response = await putFile(server, path, {
        revision: sha256(""),
        content: "x",
      });
      assert.equal(response.status, 404, `path ${path}`);
    }

    const oversized = await putFile(server, "note.txt", {
      revision: sha256("second\n"),
      content: "x".repeat(20 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "second\n");

    const endpoint = new URL("/file", server.url);
    endpoint.searchParams.set("path", "note.txt");
    assert.equal(
      (
        await fetch(endpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision, content: "x" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await putFile(
          server,
          "note.txt",
          { revision, content: "x" },
          {
            Origin: "http://evil.example",
          },
        )
      ).status,
      403,
    );
    assert.equal(
      await rawStatus(
        server.port,
        { Host: "evil.example" },
        `/file?path=note.txt&token=${server.token}`,
      ),
      403,
    );
  } finally {
    await server.close();
  }
});

// Reason: spec (ticket 03) — plan mode, viewer-only sessions, and persona
// permission rules must refuse a browser save with an explicit error.
test("a file save refuses plan mode, viewers, and denied personas", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-put-guard-ws-"));
  writeFileSync(join(workspace, "note.txt"), "first\n");
  const revision = sha256("first\n");

  const planBuilt = buildRuntime([], { workspace });
  const planServer = await start(planBuilt, { mode: "plan" });
  try {
    const response = await putFile(planServer, "note.txt", {
      revision,
      content: "second\n",
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /plan mode/i);
  } finally {
    await planServer.close();
  }

  const viewerBuilt = buildRuntime([], { workspace });
  viewerBuilt.approvals.mode = "deny";
  const viewerServer = await start(viewerBuilt);
  try {
    const response = await putFile(viewerServer, "note.txt", {
      revision,
      content: "second\n",
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /viewer/i);
  } finally {
    await viewerServer.close();
  }

  const personaBuilt = buildRuntime([], { workspace });
  personaBuilt.runtime.setPersona({
    name: "read-only",
    description: "",
    mode: "primary",
    permissions: { edit: { "*": "deny" } },
    body: "",
    source: "bundled",
    path: "",
  } as any);
  const personaServer = await start(personaBuilt);
  try {
    const response = await putFile(personaServer, "note.txt", {
      revision,
      content: "second\n",
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /persona/i);
    assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "first\n");
  } finally {
    await personaServer.close();
  }
});

test("a file save asks approval when the persona requires it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-put-ask-ws-"));
  writeFileSync(join(workspace, "note.txt"), "first\n");
  const built = buildRuntime([], { workspace });
  built.runtime.setPersona({
    name: "ask-edit",
    description: "",
    mode: "primary",
    permissions: { edit: { "*": "ask" } },
    body: "",
    source: "bundled",
    path: "",
  } as any);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const saving = putFile(server, "note.txt", {
      revision: sha256("first\n"),
      content: "second\n",
    });
    const request = await client.waitFor("approval_request");
    assert.equal(request.request.tool, "edit");
    client.send({ type: "approval", id: request.id, decision: "approve" });
    const response = await saving;
    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "second\n");
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: strict protocol validation rejects malformed terminal frames before
// they reach the shell transport.
test("terminal messages validate against the strict schema", () => {
  const opened = parseClientMessage(
    JSON.stringify({ type: "terminal_open", id: "t1", cols: 80, rows: 24 }),
  );
  assert.deepEqual(opened, {
    message: { type: "terminal_open", id: "t1", cols: 80, rows: 24 },
  });
  const badInput = parseClientMessage(
    JSON.stringify({ type: "terminal_input", id: "t1", data: 4 }),
  );
  assert.ok("error" in badInput);
  if ("error" in badInput) {
    assert.match(badInput.error, /data must be a string/);
  }
  for (const frame of [
    { type: "terminal_open", id: "" },
    { type: "terminal_resize", id: "t1", cols: 0, rows: 24 },
    { type: "terminal_resize", id: "t1", cols: 80, rows: "24" },
    { type: "terminal_close", id: 7 },
  ]) {
    const result = parseClientMessage(JSON.stringify(frame));
    assert.ok("error" in result, JSON.stringify(frame));
  }
  assert.equal(
    "error" in
      parseClientMessage(
        JSON.stringify({
          type: "terminal_resize",
          id: "t1",
          cols: 80,
          rows: 24,
        }),
      ),
    false,
  );
});

// Reason: spec (ticket 03) — the PTY carries raw bytes, so the browser needs a
// started/output/exit sequence that proves input reached a real shell.
test("a terminal streams output, accepts input, and exits", async () => {
  const built = buildRuntime([]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await openTerminal(client, "t1");
    client.send({
      type: "terminal_input",
      id: "t1",
      data: "printf 'HELLO\\n'; exit 7\r",
    });
    await terminalOutput(client, "t1", "HELLO");
    const exited = await terminalExit(client, "t1");
    assert.equal(exited.code, 7);

    client.send({ type: "terminal_input", id: "t1", data: "again" });
    const error = await client.waitForMatching((m) => m.type === "error");
    assert.match(error.message, /unknown terminal session/);
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: full-screen programs need a real resize; invalid bounds and ids
// must be rejected instead of crashing the shell transport.
test("terminal resize validates bounds and closed sessions", async () => {
  const built = buildRuntime([]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await openTerminal(client, "t2", 80, 24);

    client.send({ type: "terminal_resize", id: "t2", cols: 0, rows: 24 });
    assert.match(
      (await client.waitForMatching((m) => m.type === "error")).message,
      /cols and rows/,
    );
    client.send({ type: "terminal_resize", id: "t2", cols: 80, rows: 24.5 });
    assert.match(
      (await client.waitForMatching((m) => m.type === "error")).message,
      /cols and rows/,
    );

    client.send({ type: "terminal_resize", id: "t2", cols: 100, rows: 30 });
    client.send({ type: "terminal_input", id: "t2", data: "stty size\r" });
    const size = await client.waitForMatching(
      (m) => m.type === "terminal_output" && /30 100/.test(m.data),
    );
    assert.ok(size);

    for (const message of [
      { type: "terminal_input", id: "missing", data: "x" },
      { type: "terminal_resize", id: "missing", cols: 80, rows: 24 },
      { type: "terminal_close", id: "missing" },
    ]) {
      client.send(message);
      assert.match(
        (await client.waitForMatching((m) => m.type === "error")).message,
        /unknown terminal session/,
      );
    }

    const exit = terminalExit(client, "t2");
    client.send({ type: "terminal_close", id: "t2" });
    await exit;
    client.send({ type: "terminal_resize", id: "t2", cols: 80, rows: 24 });
    assert.match(
      (await client.waitForMatching((m) => m.type === "error")).message,
      /unknown terminal session/,
    );
  } finally {
    client.close();
    await server.close();
  }
});

// Reason: spec (ticket 03) — browser shell access follows the agent's shell
// approval boundary: controller tab only, plan mode, persona, then dialog.
test("a terminal open requires a controller, mode, persona, and approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-pty-guard-ws-"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  const viewer = new Client(server.wsUrl);
  try {
    await client.open();
    await viewer.open();
    assert.equal((await viewer.waitFor("hello")).readOnly, true);

    viewer.send({ type: "terminal_open", id: "v1" });
    assert.match(
      (await viewer.waitForMatching((m) => m.type === "error")).message,
      /read-only viewer/,
    );

    client.send({ type: "terminal_open", id: "d1" });
    const request = await client.waitFor("approval_request");
    assert.equal(request.request.tool, "bash");
    client.send({ type: "approval", id: request.id, decision: "deny" });
    assert.match(
      (await client.waitForMatching((m) => m.type === "error")).message,
      /denied/,
    );
  } finally {
    client.close();
    viewer.close();
    await server.close();
  }

  const planBuilt = buildRuntime([], { workspace });
  const planServer = await start(planBuilt, { mode: "plan" });
  const planClient = new Client(planServer.wsUrl);
  try {
    await planClient.open();
    planClient.send({ type: "terminal_open", id: "p1" });
    assert.match(
      (await planClient.waitForMatching((m) => m.type === "error")).message,
      /plan mode/,
    );
  } finally {
    planClient.close();
    await planServer.close();
  }

  const personaBuilt = buildRuntime([], { workspace });
  personaBuilt.runtime.setPersona({
    name: "no-shell",
    description: "",
    mode: "primary",
    permissions: { bash: { "*": "deny" } },
    body: "",
    source: "bundled",
    path: "",
  } as any);
  const personaServer = await start(personaBuilt);
  const personaClient = new Client(personaServer.wsUrl);
  try {
    await personaClient.open();
    personaClient.send({ type: "terminal_open", id: "g1" });
    assert.match(
      (await personaClient.waitForMatching((m) => m.type === "error")).message,
      /persona permissions/,
    );
  } finally {
    personaClient.close();
    await personaServer.close();
  }
});

// Reason: several terminal tabs stay open at once, but an unbounded browser
// could otherwise spawn shells until the host runs out of resources.
test("terminal sessions are capped at four", async () => {
  const built = buildRuntime([]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    for (let index = 0; index < 4; index += 1) {
      await openTerminal(client, `cap${index}`);
    }
    client.send({ type: "terminal_open", id: "cap4" });
    assert.match(
      (await client.waitForMatching((m) => m.type === "error")).message,
      /at most four|cap reached/i,
    );
  } finally {
    client.close();
    await server.close();
  }
});

async function startLongShell(
  client: Client,
  workspace: string,
  id: string,
): Promise<number> {
  const pidPath = join(workspace, `${id}.pid`);
  client.send({ type: "terminal_open", id });
  const request = await client.waitForNext("approval_request");
  client.send({ type: "approval", id: request.id, decision: "approve" });
  await client.waitForMatching(
    (m) => m.type === "terminal_started" && m.id === id,
  );
  client.send({
    type: "terminal_input",
    id,
    data: `echo $$ > ${pidPath}; printf 'READY_%s\\n' "$$"; read answer\r`,
  });
  await client.waitForMatching(
    (m) =>
      m.type === "terminal_output" && m.id === id && /READY_\d+/.test(m.data),
  );
  return Number(readFileSync(pidPath, "utf8").trim());
}

// Reason: cleanup is observable at the server seam through terminal_exited and
// the absence of the shell process, not by sleeping and hoping.
test("closing a terminal tab kills its shell", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-pty-close-ws-"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    const pid = await startLongShell(client, workspace, "close1");
    assert.doesNotThrow(() => process.kill(pid, 0));
    const exit = terminalExit(client, "close1");
    client.send({ type: "terminal_close", id: "close1" });
    await exit;
    assert.throws(() => process.kill(pid, 0));
  } finally {
    client.close();
    await server.close();
  }
});

test("closing the socket kills its shells", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-pty-socket-ws-"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  const observer = new Client(server.wsUrl);
  try {
    await client.open();
    await observer.open();
    const pid = await startLongShell(client, workspace, "socket1");
    assert.doesNotThrow(() => process.kill(pid, 0));
    const exit = terminalExit(observer, "socket1");
    client.close();
    await exit;
    assert.throws(() => process.kill(pid, 0));
  } finally {
    client.close();
    observer.close();
    await server.close();
  }
});

test("server shutdown kills every shell", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "web-pty-shutdown-ws-"));
  const built = buildRuntime([], { workspace });
  const server = await start(built);
  const client = new Client(server.wsUrl);
  const observer = new Client(server.wsUrl);
  try {
    await client.open();
    await observer.open();
    const pid = await startLongShell(client, workspace, "shutdown1");
    assert.doesNotThrow(() => process.kill(pid, 0));
    const exit = terminalExit(observer, "shutdown1");
    const closing = server.close();
    await exit;
    await closing;
    assert.throws(() => process.kill(pid, 0));
  } finally {
    client.close();
    observer.close();
    await server.close();
  }
});

// Reason: a chatty command must not grow the browser buffer without bound.
test("terminal output is capped per session", async () => {
  const built = buildRuntime([]);
  const server = await start(built);
  const client = new Client(server.wsUrl);
  try {
    await client.open();
    await openTerminal(client, "capped1");
    const exit = terminalExit(client, "capped1");
    client.send({
      type: "terminal_input",
      id: "capped1",
      data: "yes 0123456789 | head -c 70000; exit 0\r",
    });
    await exit;
    const sent = client.messages
      .filter((m) => m.type === "terminal_output" && m.id === "capped1")
      .reduce((total, m) => total + m.data.length, 0);
    assert.ok(sent <= 60_000, `${sent} characters sent`);
    assert.ok(
      client.messages.some(
        (m) => m.type === "error" && /output limit/.test(m.message),
      ),
    );
  } finally {
    client.close();
    await server.close();
  }
});
