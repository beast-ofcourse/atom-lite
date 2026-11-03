import type { ToolCall } from "../types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { LockManager, type Release } from "./locks.js";

function resourceKey(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd ?? "";
  return String(p);
}

function isMutation(call: ToolCall): boolean {
  return call.name === "write" || call.name === "edit";
}

function isBash(call: ToolCall): boolean {
  return call.name === "bash";
}

export async function executeToolBatch(
  calls: ToolCall[],
  toolMap: Map<string, Tool>,
  ctx: ToolContext,
  maxParallel: number,
  signal: AbortSignal,
  lockManager?: LockManager,
): Promise<ToolResult[]> {
  const lm = lockManager ?? new LockManager();
  const n = calls.length;
  const results: ToolResult[] = new Array(n);

  const acquire = async (call: ToolCall): Promise<Release> => {
    if (isBash(call)) return lm.acquireGlobal(signal);
    if (call.name === "webfetch" || call.name === "websearch") {
      // No file lock; network-only. Return a no-op release.
      return () => {};
    }
    const key = resourceKey(call);
    if (key === "") return () => {};
    if (isMutation(call)) return lm.acquireWrite(key, signal);
    return lm.acquireRead(key, signal);
  };

  // Concurrency pool
  let active = 0;
  const queue: Array<() => void> = [];
  function acquireSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (active < maxParallel) {
        active++;
        resolve();
      } else {
        queue.push(resolve);
      }
    });
  }
  function releaseSlot() {
    if (queue.length > 0) {
      const next = queue.shift()!;
      next();
    } else {
      active--;
    }
  }

  const tasks = calls.map((call, i) => {
    return (async () => {
      if (signal.aborted) {
        results[i] = { toolCallId: call.id, name: call.name, content: "USER_CANCELLED", isError: true };
        return;
      }
      let release: Release | undefined;
      await acquireSlot();
      try {
        release = await acquire(call);
        if (signal.aborted) {
          results[i] = { toolCallId: call.id, name: call.name, content: "USER_CANCELLED", isError: true };
          return;
        }
        const tool = toolMap.get(call.name);
        if (!tool) {
          results[i] = { toolCallId: call.id, name: call.name, content: `TOOL_NOT_FOUND: ${call.name}`, isError: true };
        } else {
          const r = await tool.execute(call, ctx);
          results[i] = r;
        }
      } catch (err) {
        results[i] = {
          toolCallId: call.id,
          name: call.name,
          content: `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      } finally {
        if (release) release();
        releaseSlot();
      }
    })();
  });

  await Promise.all(tasks);
  return results;
}

export { LockManager };
export type { Release };
