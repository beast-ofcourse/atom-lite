import type { ToolCall } from "../types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { resolve } from "node:path";
import { LockManager, type Release } from "./locks.js";

function resourceKey(call: ToolCall, workspace: string): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd ?? "";
  const key = String(p);
  return key === "" ? "" : resolve(workspace, key);
}

function isMutation(call: ToolCall): boolean {
  return call.name === "write" || call.name === "edit";
}

function isBash(call: ToolCall): boolean {
  return call.name === "bash";
}

function isRemote(call: ToolCall): boolean {
  return call.name.startsWith("mcp__");
}

export interface ToolExecutorOptions {
  maxParallelToolCalls?: number;
  bashConcurrency?: "serial" | "parallel";
  limits?: unknown;
}

export class ToolExecutor {
  private maxParallel: number;
  private bashConcurrency: "serial" | "parallel";

  constructor(options: ToolExecutorOptions = {}) {
    this.maxParallel = options.maxParallelToolCalls ?? 4;
    this.bashConcurrency = options.bashConcurrency ?? "serial";
  }

  async run(
    calls: ToolCall[],
    context: ToolContext & { toolMap: Map<string, Tool>; lockManager?: LockManager },
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    const toolMap = context.toolMap;
    const lockManager = context.lockManager;
    const ctx = context;
    const lm = lockManager ?? new LockManager();
    const n = calls.length;
    const results: ToolResult[] = new Array(n);
    const maxParallel = this.maxParallel;
    const bashConcurrency = this.bashConcurrency;

    const acquire = async (call: ToolCall): Promise<Release> => {
      if (isBash(call)) {
        return bashConcurrency === "parallel"
          ? lm.acquireGlobalBarrier(signal)
          : lm.acquireGlobal(signal);
      }
      if (call.name === "webfetch" || call.name === "websearch") {
        return () => {};
      }
      if (isRemote(call)) {
        return () => {};
      }
      const key = resourceKey(call, ctx.workspace);
      if (key === "") return () => {};
      const tool = toolMap.get(call.name);
      const readOnly = tool?.annotations?.readOnlyHint === true;
      if (isMutation(call)) return lm.acquireWrite(key, signal);
      // Extension tools: read-only hint => read lock; otherwise (including
      // unclassified path-bearing tools) => write lock.
      if (tool?.annotations !== undefined && !readOnly) {
        return lm.acquireWrite(key, signal);
      }
      return lm.acquireRead(key, signal);
    };

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
}
