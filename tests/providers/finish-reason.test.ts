// Regression: providers used to hardcode "stop"/"tool_calls", so a response
// cut off at the model's output limit was indistinguishable from a complete
// answer and the agent never warned the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Message, ModelRequest, ModelResponse } from "../../dist/types.js";
import type { ProviderAdapter } from "../../dist/providers/types.js";
import { resolveFinishReason } from "../../dist/providers/finish-reason.js";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";
import { OllamaAdapter } from "../../dist/providers/ollama.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

test("finish reason mapping recognizes provider stop reasons", () => {
  assert.equal(resolveFinishReason("length", false), "length");
  assert.equal(resolveFinishReason("MAX_TOKENS", true), "length");
  assert.equal(resolveFinishReason("max_tokens", false), "length");
  assert.equal(resolveFinishReason("content_filter", false), "error");
  assert.equal(resolveFinishReason("stop", false), "stop");
  assert.equal(resolveFinishReason("tool_calls", true), "tool_calls");
  assert.equal(resolveFinishReason(undefined, true), "tool_calls");
});

test("OpenAI-compatible generate propagates finish_reason length", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "cut off mid sentence" },
            finish_reason: "length",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-model",
    });
    const response = await adapter.generate({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(response.finishReason, "length");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI-compatible generate propagates content_filter as error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "" },
            finish_reason: "content_filter",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-model",
    });
    const response = await adapter.generate({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(response.finishReason, "error");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Gemini maps MAX_TOKENS to a truncated finish reason", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new GeminiAdapter({
      id: "gemini",
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const response = await adapter.generate({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(response.finishReason, "length");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Ollama maps done_reason length to a truncated finish reason", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: { content: "cut" },
        done: true,
        done_reason: "length",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new OllamaAdapter({
      id: "ollama",
      model: "test-model",
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const response = await adapter.generate({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(response.finishReason, "length");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI-compatible stream propagates finish_reason length", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        "data: [DONE]\n\n",
    );
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-model",
    });
    let done: any;
    for await (const event of adapter.stream({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      if (event.type === "done") done = event.response;
    }
    assert.equal(done.finishReason, "length");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent loop surfaces a truncated response instead of treating it as complete", async () => {
  const events: string[] = [];
  const provider = new FakeProvider([
    { text: "partial answer", finishReason: "length" },
    { text: " continued" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    model: "test-model",
    onEvent: (event) => {
      if (event.type === "response_truncated") events.push(event.model);
    },
  });
  const result = await runtime.runAgentTurn(
    "say something long",
    new InMemorySession("s1", "/tmp/ws"),
    new AbortController().signal,
  );
  assert.equal(result, "partial answer continued");
  assert.deepEqual(events, ["test-model"]);
});

test("agent loop resumes once after a truncated answer and returns the full text", async () => {
  const events: string[] = [];
  const provider = new FakeProvider([
    { text: "first half", finishReason: "length" },
    { text: " second half" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    model: "fake",
    onEvent: (event) => {
      if (event.type === "response_truncated") events.push(event.model);
    },
  });
  const session = new InMemorySession("s2", "/tmp/ws");
  const result = await runtime.runAgentTurn(
    "answer me",
    session,
    new AbortController().signal,
  );

  assert.equal(result, "first half second half");
  assert.equal(
    session.messages.filter((m) => m.role === "assistant").length,
    2,
  );
  assert.equal(
    session.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (part) => part.type === "text" && part.text.includes("cut off"),
        ),
    ).length,
    1,
  );
  assert.deepEqual(events, ["fake"]);
});

test("truncation recovery is bounded when every answer is cut off", async () => {
  const events: string[] = [];
  const provider = new FakeProvider([
    { text: "one ", finishReason: "length" },
    { text: "two ", finishReason: "length" },
    { text: "three ", finishReason: "length" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    onEvent: (event) => {
      if (event.type === "response_truncated") events.push(event.model);
    },
  });
  const session = new InMemorySession("s3", "/tmp/ws");
  const result = await runtime.runAgentTurn(
    "answer me",
    session,
    new AbortController().signal,
  );
  assert.equal(result, "one two ");
  assert.equal(
    session.messages.filter((m) => m.role === "assistant").length,
    2,
  );
  assert.equal(events.length, 1);
});

test("continuation hint is sent as a user turn after the truncated answer", async () => {
  const seen: Message[][] = [];
  const provider: ProviderAdapter = {
    id: "capture",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      seen.push(request.messages);
      const call = seen.length;
      return {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: call === 1 ? "first half" : "second half" },
          ],
        },
        toolCalls: [],
        finishReason: call === 1 ? "length" : "stop",
      };
    },
  };
  const runtime = new AgentRuntime({ provider, tools: [] });
  await runtime.runAgentTurn(
    "answer",
    new InMemorySession("s4", "/tmp/ws"),
    new AbortController().signal,
  );

  assert.equal(seen.length, 2);
  const index = seen[1].findIndex(
    (m) =>
      m.role === "user" &&
      m.content.some(
        (part) => part.type === "text" && part.text.includes("cut off"),
      ),
  );
  assert.ok(index > 0);
  assert.equal(seen[1][index - 1].role, "assistant");
});

test("blocked responses surface an agent error event", async () => {
  const errors: string[] = [];
  const provider: ProviderAdapter = {
    id: "blocked",
    async generate(): Promise<ModelResponse> {
      return {
        message: { role: "assistant", content: [] },
        toolCalls: [],
        finishReason: "error",
      };
    },
  };
  const runtime = new AgentRuntime({
    provider,
    tools: [],
    onEvent: (event) => {
      if (event.type === "error") errors.push(event.message);
    },
  });
  await runtime.runAgentTurn(
    "answer",
    new InMemorySession("s5", "/tmp/ws"),
    new AbortController().signal,
  );
  assert.deepEqual(errors, ["response blocked by the model provider"]);
});
