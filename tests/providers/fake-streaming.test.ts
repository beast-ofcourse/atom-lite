import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider } from "../../dist/providers/fake.js";

const request = { model: "fake", messages: [] };

test("streaming fake provider emits deterministic chunks and a done response", async () => {
  const provider = new FakeProvider(
    [
      {
        text: "hello world",
        usage: { input: 3, output: 2 },
      },
    ],
    { stream: true, chunkSize: 4 },
  );
  assert.equal(typeof provider.stream, "function");
  const events = [];
  for await (const event of provider.stream!(request)) {
    events.push(event);
  }
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.text),
    ["hell", "o wo", "rld"],
  );
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.response.usage?.output, 2);
  assert.equal(done?.response.message.content?.[0]?.text, "hello world");
});

test("streaming fake provider emits tool calls before the done response", async () => {
  const provider = new FakeProvider(
    [
      {
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }],
      },
    ],
    { stream: true },
  );
  const events = [];
  for await (const event of provider.stream!(request)) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "tool_call");
  assert.equal(events[0]?.toolCall.id, "c1");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.at(-1)?.response.finishReason, "tool_calls");
});

test("strict fake provider fails loudly when the script is exhausted", async () => {
  const provider = new FakeProvider([], { stream: true, strict: true });
  await assert.rejects(async () => {
    for await (const _event of provider.stream!(request)) {
      // drain
    }
  }, /FakeProvider script exhausted/);
});

test("a response hook answers summarizer calls without consuming the script", async () => {
  const provider = new FakeProvider([{ text: "done" }], {
    stream: true,
    respond: (incoming) => {
      const text = JSON.stringify(incoming.messages);
      return text.includes("summarize") ? { text: "summary" } : undefined;
    },
  });
  const summary = await provider.generate({
    model: "fake",
    messages: [
      { role: "user", content: [{ type: "text", text: "summarize this" }] },
    ],
  });
  assert.equal(summary.message.content?.[0]?.text, "summary");
  const events = [];
  for await (const event of provider.stream!(request)) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.response.message.content?.[0]?.text, "done");
});
