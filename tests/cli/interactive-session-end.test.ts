// Ticket 07: the interactive exit path must notify extensions before the
// process tears down. The TUI and process.exit are faked so the ordering is
// observable without a pseudo-terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeInteractiveSession } from "../../dist/cli/app.js";

test("interactive exit notifies session_end before shutdown and exit", async () => {
  const order: string[] = [];
  await closeInteractiveSession(
    {
      notifySessionEnd: async () => {
        order.push("session_end");
      },
    } as any,
    async () => {
      order.push("shutdown");
    },
    (code) => {
      order.push(`exit:${code}`);
    },
  );
  assert.deepEqual(order, ["session_end", "shutdown", "exit:0"]);
});

test("a failing session_end handler does not block interactive exit", async () => {
  const order: string[] = [];
  await closeInteractiveSession(
    {
      notifySessionEnd: async () => {
        throw new Error("end failed");
      },
    } as any,
    async () => {
      order.push("shutdown");
    },
    (code) => {
      order.push(`exit:${code}`);
    },
  );
  assert.deepEqual(order, ["shutdown", "exit:0"]);
});
