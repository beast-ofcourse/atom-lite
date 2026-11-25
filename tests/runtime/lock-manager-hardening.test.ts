// Regression: executeToolBatch used to accept a shared LockManager and never
// pass it to the executor, and AgentRuntime created a new manager per batch.
// An external exclusive global lock must block a bash call. Also pins the bound
// of the live lock map a shared manager keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  LockManager,
  MAX_LOCK_CACHE_ENTRIES,
  type Release,
} from "../../dist/runtime/locks.js";
import { executeToolBatch } from "../../dist/runtime/scheduler.js";
import { AgentRuntime } from "../../dist/agent/loop.js";
import { FakeProvider } from "../../dist/providers/fake.js";
import { InMemorySession } from "../../dist/sessions/store.js";

const signal = new AbortController().signal;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBashTool(ran: { value: boolean }): any {
  return {
    definition: { name: "bash", description: "fake", parameters: {} },
    async execute(call: any) {
      ran.value = true;
      return {
        toolCallId: call.id,
        name: "bash",
        content: "ok",
      };
    },
  };
}

test("executeToolBatch honors a supplied shared LockManager", async () => {
  const lm = new LockManager();
  const releaseBarrier = await lm.acquireGlobal(signal);
  const ran = { value: false };
  const toolMap = new Map([["bash", fakeBashTool(ran)]]);

  let settled = false;
  const batch = executeToolBatch(
    [{ id: "1", name: "bash", arguments: { command: "echo hi" } }] as any,
    toolMap,
    {
      workspace: "/tmp",
      signal,
      maxBashTimeMs: 1000,
      maxToolOutputBytes: 100,
    } as any,
    1,
    signal,
    lm,
  ).then((res) => {
    settled = true;
    return res;
  });

  await delay(30);
  assert.equal(
    settled,
    false,
    "batch ran despite an external barrier on the shared lock manager",
  );
  assert.equal(ran.value, false);

  releaseBarrier();
  const results = await Promise.race([
    batch,
    delay(2000).then(() => {
      throw new Error("batch never completed after barrier release");
    }),
  ]);
  assert.equal(settled, true);
  assert.equal(results[0].toolCallId, "1");
});

test("agent runtime uses its shared lock manager for tool batches", async () => {
  const lm = new LockManager();
  const releaseBarrier = await lm.acquireGlobal(signal);
  const ran = { value: false };
  const provider = new FakeProvider([
    { toolCalls: [{ id: "1", name: "bash", arguments: { command: "hi" } }] },
    { text: "done" },
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: [fakeBashTool(ran)],
    lockManager: lm,
  });

  let settled = false;
  const turn = runtime
    .runAgentTurn("go", new InMemorySession("runtime", "/tmp"), signal)
    .then((result) => {
      settled = true;
      return result;
    });
  await delay(30);
  assert.equal(
    settled,
    false,
    "tool ran despite a barrier on the runtime's lock manager",
  );

  releaseBarrier();
  const result = await Promise.race([
    turn,
    delay(2000).then(() => {
      throw new Error("turn never completed after barrier release");
    }),
  ]);
  assert.equal(result, "done");
  assert.equal(ran.value, true);
});

test("shared manager keeps its live lock map bounded across many paths", async () => {
  const lm = new LockManager();
  // 3x the cap: without eviction the map grows linearly with paths touched.
  for (let i = 0; i < MAX_LOCK_CACHE_ENTRIES * 3; i++) {
    const release = await lm.acquireWrite(
      `/atom-lite-bounds-${i}/file.txt`,
      signal,
    );
    release();
  }
  const stats = lm.cacheStats;
  assert.ok(
    stats.locks <= MAX_LOCK_CACHE_ENTRIES,
    `lock map grew to ${stats.locks}`,
  );
});

test("eviction never drops a lock that is currently held", async () => {
  const lm = new LockManager();
  const heldKey = "/atom-lite-held/retained.txt";
  const releaseHeld = await lm.acquireWrite(heldKey, signal);

  for (let i = 0; i < MAX_LOCK_CACHE_ENTRIES + 50; i++) {
    const release = await lm.acquireWrite(
      `/atom-lite-churn-${i}/file.txt`,
      signal,
    );
    release();
  }

  let acquiredWhileHeld = false;
  const second = lm.acquireWrite(heldKey, signal).then((release) => {
    acquiredWhileHeld = true;
    return release;
  });
  await delay(30);
  assert.equal(
    acquiredWhileHeld,
    false,
    "a held lock was evicted, allowing two owners of one resource",
  );

  releaseHeld();
  const releaseSecond = await Promise.race([
    second,
    delay(2000).then(() => {
      throw new Error("second acquisition never completed after release");
    }),
  ]);
  releaseSecond();
});

// drain() used to grant queued readers without the queue-head guard that
// acquire() applies, so a writer could be starved by readers arriving later.
test("a queued writer is not starved by later readers", async () => {
  const lm = new LockManager();
  const key = "/atom-lite-fairness/file.txt";
  const releaseR1 = await lm.acquireRead(key, signal);
  const releaseR2 = await lm.acquireRead(key, signal);

  let writerAcquired = false;
  const writer = lm.acquireWrite(key, signal).then((release) => {
    writerAcquired = true;
    return release;
  });
  await delay(10);
  assert.equal(writerAcquired, false);

  const trailingReader = lm.acquireRead(key, signal);
  await delay(10);
  releaseR1();
  await delay(20);
  releaseR2();
  await delay(20);

  assert.equal(
    writerAcquired,
    true,
    "writer stayed blocked after all earlier readers released",
  );

  const releaseWriter = await writer;
  releaseWriter();
  const releaseTrailing = await Promise.race([
    trailingReader,
    delay(2000).then(() => {
      throw new Error("trailing reader never completed after writer released");
    }),
  ]);
  releaseTrailing();
});

test("granted waiters detach abort listeners from a reused turn signal", async () => {
  const lm = new LockManager();
  const controller = new AbortController();
  const key = "/atom-lite-abort/file.txt";
  const releaseWrite = await lm.acquireWrite(key, controller.signal);

  const pending: Promise<Release>[] = [];
  for (let i = 0; i < 20; i++) {
    pending.push(lm.acquireRead(key, controller.signal));
  }
  await delay(20);
  assert.equal(getEventListeners(controller.signal, "abort").length, 20);

  releaseWrite();
  const releases = await Promise.race([
    Promise.all(pending),
    delay(2000).then(() => {
      throw new Error("queued readers never completed");
    }),
  ]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const release of releases) release();
});
