import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";

async function capturedEffort(
  options: Record<string, unknown>,
  stream: boolean,
): Promise<unknown> {
  let body: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, {
        "content-type": stream ? "text/event-stream" : "application/json",
      });
      res.end(
        stream
          ? "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
          : JSON.stringify({
              choices: [{ message: { role: "assistant", content: "hi" } }],
            }),
      );
    });
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
    const request = {
      model: "test-model",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      options,
    };
    if (stream) {
      for await (const _event of adapter.stream(request)) {
        // consume the stream
      }
    } else {
      await adapter.generate(request);
    }
    return body?.reasoning_effort;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("generate maps neutral effort levels to OpenAI-compatible values", async () => {
  assert.equal(await capturedEffort({ effort: "off" }, false), "none");
  assert.equal(await capturedEffort({ reasoning: "off" }, false), "none");
  assert.equal(await capturedEffort({ effort: "max" }, false), "xhigh");
  assert.equal(await capturedEffort({ effort: "high" }, false), "high");
});

test("stream maps neutral effort levels to OpenAI-compatible values", async () => {
  assert.equal(await capturedEffort({ effort: "off" }, true), "none");
  assert.equal(await capturedEffort({ reasoning: "off" }, true), "none");
  assert.equal(await capturedEffort({ effort: "max" }, true), "xhigh");
});

test("native effort levels pass through", async () => {
  assert.equal(await capturedEffort({ effort: "minimal" }, false), "minimal");
  assert.equal(await capturedEffort({ effort: "none" }, false), "none");
  assert.equal(await capturedEffort({ effort: "xhigh" }, false), "xhigh");
});
