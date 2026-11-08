import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runModelTurn } from "../../dist/agent/model-turn.js";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";
import { GeminiAdapter } from "../../dist/providers/gemini.js";

const userMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

class CapturingProvider {
  readonly id = "capture";
  readonly requests: any[] = [];

  async generate(request: any) {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

async function collectTurn(
  temperature?: number,
): Promise<{ provider: CapturingProvider; request: any }> {
  const provider = new CapturingProvider();
  for await (const _event of runModelTurn({
    provider,
    model: "test-model",
    messages: [userMessage] as any,
    tools: [],
    effort: "medium",
    temperature,
    signal: new AbortController().signal,
  })) {
    // Consume the whole turn so the provider request is observed.
  }
  return { provider, request: provider.requests[0] };
}

async function withServer(
  handler: (body: any, res: any) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => handler(JSON.parse(raw || "{}"), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("model turn forwards persona temperature to the provider request", async () => {
  const { request } = await collectTurn(0.15);
  assert.deepEqual(request.options, { effort: "medium", temperature: 0.15 });
});

test("model turn omits temperature when the persona does not set one", async () => {
  const { request } = await collectTurn(undefined);
  assert.deepEqual(request.options, { effort: "medium" });
  assert.equal("temperature" in request.options, false);
});

test("OpenAI-compatible adapter sends temperature in the request body", async () => {
  let body: any;
  await withServer(
    (seen, res) => {
      body = seen;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (port) => {
      const adapter = new OpenAICompatibleAdapter({
        id: "test",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "test-model",
      });
      await adapter.generate({
        model: "test-model",
        messages: [userMessage] as any,
        options: { temperature: 0.15 },
      });
    },
  );
  assert.equal(body.temperature, 0.15);
});

test("Gemini adapter sends temperature through generationConfig", async () => {
  let body: any;
  await withServer(
    (seen, res) => {
      body = seen;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
      );
    },
    async (port) => {
      const adapter = new GeminiAdapter({
        id: "test",
        model: "gemini-test",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${port}`,
      });
      await adapter.generate({
        model: "gemini-test",
        messages: [userMessage] as any,
        options: { temperature: 0.15 },
      });
    },
  );
  assert.equal(body.generationConfig.temperature, 0.15);
});
