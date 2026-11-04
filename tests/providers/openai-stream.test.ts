import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../../dist/providers/openai-compatible.js";

test("OpenAI-compatible stream retries without stream_options and keeps usage", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests++;
      if (raw.includes('"stream_options"')) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stream_options is unsupported" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n' +
          "data: [DONE]\n\n",
      );
      res.end();
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
    let text = "";
    let usage: any;
    for await (const event of adapter.stream({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      if (event.type === "text") text += event.text;
      if (event.type === "done") usage = event.response.usage;
    }
    assert.equal(text, "hi");
    assert.deepEqual(usage, { input: 100, output: 5, total: 105 });
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
