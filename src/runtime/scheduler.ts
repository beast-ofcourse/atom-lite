import type { ToolCall } from "../types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { ToolExecutor } from "./tool-executor.js";
import { LockManager } from "./locks.js";

export { ToolExecutor } from "./tool-executor.js";
export { LockManager };
export type { Release } from "./locks.js";

export async function executeToolBatch(
  calls: ToolCall[],
  toolMap: Map<string, Tool>,
  ctx: ToolContext,
  maxParallel: number,
  signal: AbortSignal,
  lockManager?: LockManager,
  bashConcurrency: "serial" | "parallel" = "parallel",
): Promise<ToolResult[]> {
  const executor = new ToolExecutor({
    maxParallelToolCalls: maxParallel,
    bashConcurrency,
  });
  return executor.run(calls, { ...ctx, toolMap, lockManager }, signal);
}

export async function executeToolBatchStreaming(
  calls: ToolCall[],
  toolMap: Map<string, Tool>,
  ctx: ToolContext,
  maxParallel: number,
  signal: AbortSignal,
  onResult: (result: ToolResult) => void | Promise<void>,
  lockManager?: LockManager,
  bashConcurrency: "serial" | "parallel" = "parallel",
): Promise<void> {
  const executor = new ToolExecutor({
    maxParallelToolCalls: maxParallel,
    bashConcurrency,
  });
  await executor.runStreaming(
    calls,
    { ...ctx, toolMap, lockManager },
    signal,
    onResult,
  );
}
