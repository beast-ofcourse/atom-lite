import type { ToolCall } from "../types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";

export interface ScheduledCall {
  call: ToolCall;
  tool: Tool | undefined;
}

function resourceKey(call: ToolCall): string | null {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd;
  return typeof p === "string" ? `file:${p}` : null;
}

function isMutation(call: ToolCall): boolean {
  return call.name === "write" || call.name === "edit";
}

function isBash(call: ToolCall): boolean {
  return call.name === "bash";
}

function conflicts(a: ToolCall, b: ToolCall): boolean {
  if (isBash(a) || isBash(b)) return true;
  const ra = resourceKey(a);
  const rb = resourceKey(b);
  if (ra === null || rb === null) return false;
  if (ra !== rb) return false;
  // same file: conflict if at least one is a mutation
  return isMutation(a) || isMutation(b);
}

export async function executeToolBatch(
  calls: ToolCall[],
  toolMap: Map<string, Tool>,
  ctx: ToolContext,
  maxParallel: number,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  const n = calls.length;
  const results: ToolResult[] = new Array(n);
  const completion: Array<Promise<void>> = new Array(n);
  const resolvers: Array<() => void> = new Array(n);

  for (let i = 0; i < n; i++) {
    completion[i] = new Promise<void>((resolve) => {
      resolvers[i] = resolve;
    });
  }

  // compute blockers for each call
  const blockers: number[][] = calls.map((_, i) => {
    const out: number[] = [];
    for (let j = 0; j < i; j++) {
      if (conflicts(calls[i], calls[j])) out.push(j);
    }
    return out;
  });

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
      // wait for blockers
      await Promise.all(blockers[i].map((b) => completion[b]));
      if (signal.aborted) {
        results[i] = { toolCallId: call.id, name: call.name, content: "USER_CANCELLED", isError: true };
        resolvers[i]();
        return;
      }
      await acquireSlot();
      try {
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
        releaseSlot();
        resolvers[i]();
      }
    })();
  });

  await Promise.all(tasks);
  return results;
}