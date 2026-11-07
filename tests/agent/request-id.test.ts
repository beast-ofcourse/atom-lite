import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type { ModelRequest } from "../../dist/types.js";

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
