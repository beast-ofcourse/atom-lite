import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { ContextManager } from "../../dist/context/manager.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";
import { FileUsageLedger } from "../../dist/usage/ledger.js";
import { loadConfig } from "../../dist/config/load.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../dist/types.js";
import { SUMMARY_HEADINGS } from "../../dist/context/checkpoint.js";

const VALID_SUMMARY = SUMMARY_HEADINGS.map((h) => `${h}\n- value`).join("\n\n");

test("a config-enabled ledger writes records to the configured path after a call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-cfg-"));
  const userPath = join(dir, "config.json");
  const ledgerPath = join(dir, "usage.jsonl");
  writeFileSync(
    userPath,
    JSON.stringify({ usage: { ledgerEnabled: true, ledgerPath } }),
  );
  const cfg = loadConfig({
    userConfigPath: userPath,
    projectRoot: join(dir, "workspace"),
  });

  const provider = new FakeProvider([
    { text: "ok", usage: { input: 5, output: 1, total: 6 } },
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    usageLedger: new FileUsageLedger(cfg.usage.ledgerPath!),
  });
  await runtime.runAgentTurn(
    "hi",
    new InMemorySession("sess-cfg", dir),
    new AbortController().signal,
  );

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).sessionId, "sess-cfg");
  assert.deepEqual(JSON.parse(lines[0]).usage, {
    input: 5,
    output: 1,
    total: 6,
  });
});

test("compaction summarizer calls produce their own ledger record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-compact-"));
  const provider = new FakeProvider([
    { text: VALID_SUMMARY, usage: { input: 40, output: 9, total: 49 } },
    { text: "answer", usage: { input: 12, output: 3, total: 15 } },
  ]);
  const records: any[] = [];
  const usageLedger = { record: (r: any) => records.push(r) };
  const contextManager = new ContextManager({
    systemPrompt: "system",
    maxInputTokens: null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    compactEveryNTurns: 1,
    compactionModel: "summarizer-model",
    provider,
    model: "main-model",
    usageLedger,
  });
  const runtime = new AgentRuntime({
    provider,
    model: "main-model",
    workspace: dir,
    tools: [],
    contextManager,
    usageLedger,
  });
  const session = new InMemorySession("sess-compact", dir);
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "old" }],
  });
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "older answer" }],
  });

  await runtime.runAgentTurn(
    "new question",
    session,
    new AbortController().signal,
    { requestId: "req-compact" },
  );

  assert.equal(records.length, 2);
  const summaryRecord = records.find((r) => r.model === "summarizer-model");
  const mainRecord = records.find((r) => r.model === "main-model");
  assert.ok(summaryRecord);
  assert.ok(mainRecord);
  assert.deepEqual(summaryRecord.usage, { input: 40, output: 9, total: 49 });
  assert.deepEqual(mainRecord.usage, { input: 12, output: 3, total: 15 });
  assert.equal(summaryRecord.sessionId, "sess-compact");
  assert.equal(summaryRecord.requestId, "req-compact");
  assert.equal(mainRecord.requestId, "req-compact");
});

class StreamingProvider implements ProviderAdapter {
  readonly id = "streaming";
  readonly model = "stream-model";
  readonly modelRequest: ModelRequest[] = [];

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "text", text: "streamed" };
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "streamed" }],
        },
        toolCalls: [],
        finishReason: "stop",
        usage: { input: 7, output: 2, total: 9 },
        requestId: "adapter-rid",
      } as ModelResponse,
    };
  }

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("generate should not be used for this provider");
  }
}

test("streaming calls record once using the adapter-resolved request id", async () => {
  const provider = new StreamingProvider();
  const records: any[] = [];
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    usageLedger: { record: (r: any) => records.push(r) },
  });
  const result = await runtime.runAgentTurn(
    "hi",
    new InMemorySession("sess-stream", "/tmp"),
    new AbortController().signal,
    { requestId: "caller-rid" },
  );

  assert.equal(result, "streamed");
  assert.equal(records.length, 1);
  assert.equal(records[0].requestId, "adapter-rid");
  assert.deepEqual(records[0].usage, { input: 7, output: 2, total: 9 });
});

test("a throwing ledger never changes the agent response", async () => {
  const provider = new FakeProvider([{ text: "still works" }]);
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    usageLedger: {
      record: () => {
        throw new Error("disk full");
      },
    },
  });
  const result = await runtime.runAgentTurn(
    "hi",
    new InMemorySession("sess-throw", "/tmp"),
    new AbortController().signal,
  );
  assert.equal(result, "still works");
});
