import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type { ModelRequest } from "../../dist/types.js";
import type { Message } from "../../dist/types.js";

class RecordingSession {
  messages: Message[] = [];
  events: any[] = [];
  appendMessage(message: Message): void {
    this.messages.push(message);
  }
  appendEvent(partial: any): any {
    const event = { timestamp: new Date().toISOString(), ...partial };
    this.events.push(event);
    return event;
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "recording";
  requests: ModelRequest[] = [];
  async generate(request: ModelRequest): Promise<any> {
    this.requests.push(request);
    return {
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      toolCalls: [],
      finishReason: "stop",
      usage: { input: 1, output: 1 },
    };
  }
}

test("AgentRuntime forwards a caller request id to the provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const provider = new RecordingProvider();
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  const session = new InMemorySession("s1", dir);
  const result = await runtime.runAgentTurn(
    "say hi",
    session,
    new AbortController().signal,
    { requestId: "turn-rid-1" },
  );
  assert.equal(result, "done");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].requestId, "turn-rid-1");
});

test("AgentRuntime generates and persists a request id when none is supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const provider = new RecordingProvider();
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  const session = new RecordingSession();
  const result = await runtime.runAgentTurn(
    "say hi",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "done");
  const forwarded = provider.requests[0].requestId;
  assert.equal(typeof forwarded, "string");
  assert.match(forwarded!, /^[0-9a-f-]{36}$/);
  const persisted = session.events.find(
    (event) => event.type === "model_request_id",
  );
  assert.equal(persisted?.requestId, forwarded);
});

test("AgentRuntime persists a caller-supplied request id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const provider = new RecordingProvider();
  const runtime = new AgentRuntime({ provider, workspace: dir, tools: [] });
  const session = new RecordingSession();
  await runtime.runAgentTurn("say hi", session, new AbortController().signal, {
    requestId: "turn-rid-2",
  });
  assert.equal(provider.requests[0].requestId, "turn-rid-2");
  const persisted = session.events.find(
    (event) => event.type === "model_request_id",
  );
  assert.equal(persisted?.requestId, "turn-rid-2");
});
