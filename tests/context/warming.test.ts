// Contract: cache warming pings reuse the last context, stop on a reported
// cache miss, never treat a provider that reports no counters as a miss, and
// respect a bounded duration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheWarmer } from "../../dist/context/warming.js";

type Timer = { handle: number; fn: () => void; ms: number };

function harness(
  responses: any[],
  options: { intervalMs?: number; durationMs?: number } = {},
) {
  const timers: Timer[] = [];
  let nextHandle = 1;
  const requests: any[] = [];
  const provider = {
    id: "test",
    model: "m",
    generate: async (request: any) => {
      requests.push(request);
      return {
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
        toolCalls: [],
        finishReason: "stop",
        usage: responses.shift() ?? {},
      };
    },
  };
  const warmer = new CacheWarmer({
    provider: provider as any,
    model: "m",
    getMessages: () => [{ role: "system", content: "stable prefix" }],
    intervalMs: options.intervalMs ?? 1000,
    durationMs: options.durationMs ?? 10000,
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      timers.push({ handle, fn, ms });
      return handle;
    },
    cancel: (handle) => {
      const index = timers.findIndex((t) => t.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { warmer, requests, timers };
}

test("a warming tick reuses the last context and keeps going after a cache hit", async () => {
  const h = harness([{ cacheRead: 10 }, { cacheRead: 10 }]);
  h.warmer.start();
  await h.warmer.tick();
  assert.equal(h.requests.length, 1);
  assert.match(JSON.stringify(h.requests[0].messages), /stable prefix/);
  assert.ok(h.timers.length > 0);
});

test("a reported cache miss stops warming", async () => {
  const h = harness([{ cacheRead: 0 }]);
  h.warmer.start();
  await h.warmer.tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.length, 0);
  assert.equal(h.warmer.active, false);
});

test("providers reporting no cache counters never count as a miss", async () => {
  const h = harness([{}]);
  h.warmer.start();
  await h.warmer.tick();
  assert.equal(h.warmer.active, true);
  assert.ok(h.timers.length > 0);
});

test("warming stops after its duration", () => {
  const h = harness([{ cacheRead: 1 }], { durationMs: 50 });
  h.warmer.start();
  h.warmer.stop();
  assert.equal(h.warmer.active, false);
  assert.equal(h.timers.length, 0);
});
