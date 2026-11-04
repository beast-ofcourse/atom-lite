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
  bashConcurrency: "serial" | "parallel" = "serial",
): Promise<ToolResult[]> {
  const executor = new ToolExecutor({
    maxParallelToolCalls: maxParallel,
    bashConcurrency,
  });
  return executor.run(calls, toolMap, ctx, signal, lockManager);
}
