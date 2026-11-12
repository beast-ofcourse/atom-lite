import type { ToolCall } from "../types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { resolve } from "node:path";
import { LockManager, type Release } from "./locks.js";
import { isPlanToolAllowed } from "./modes.js";
import { checkApproval } from "./approvals.js";
import {
  permissionInvocation,
  resolveToolPermission,
} from "../agents/permissions.js";

function resourceKey(call: ToolCall, workspace: string): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd ?? "";
  const key = String(p);
  return key === "" ? "" : resolve(workspace, key);
}

function isMutation(call: ToolCall): boolean {
  // Workspace mutations. The todo ledger is session state, not workspace
  // state: it is serialized by its own lock key below and never triggers a
  // checkpoint.
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

/**
 * Enforce the active persona's tool policy before a tool runs. `allow` and
 * `deny` are absolute; `ask` reuses the existing approval handler.
 */
async function personaPermissionResult(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult | undefined> {
  const invocation = permissionInvocation(call.name, call.arguments);
  const match = resolveToolPermission(
    ctx.agentPermissions,
    call.name,
    invocation,
  );
  if (!match || match.decision === "allow") return undefined;

  if (match.decision === "deny") {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `PERSONA_PERMISSION_DENIED: ${call.name} matched "${match.pattern}"`,
      isError: true,
    };
  }

  if (!ctx.approvals) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `PERSONA_PERMISSION_REQUIRED: ${call.name} matched "${match.pattern}"`,
      isError: true,
    };
  }
  const decision = await checkApproval(ctx.approvals, {
    command: invocation
      ? `${call.name}: ${invocation}`
      : `${call.name} (no arguments)`,
    cwd: ctx.workspace,
    timeoutMs: 0,
    sandboxed: false,
  });
  if (decision.allowed) return undefined;
  return {
    toolCallId: call.id,
    name: call.name,
    content: `PERSONA_PERMISSION_REQUIRED: ${call.name} matched "${match.pattern}"`,
    isError: true,
  };
}

export class ToolExecutor {
  private maxParallel: number;
  private bashConcurrency: "serial" | "parallel";

  constructor(options: ToolExecutorOptions = {}) {
    this.maxParallel = Math.max(1, options.maxParallelToolCalls ?? 4);
    this.bashConcurrency = options.bashConcurrency ?? "serial";
  }

  async run(
    calls: ToolCall[],
    context: ToolContext & {
      toolMap: Map<string, Tool>;
      lockManager?: LockManager;
    },
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
      if (call.name === "todo") {
        // Serialize ledger writes without classifying them as workspace
        // mutations (no checkpoint, allowed in plan mode).
        return lm.acquireWrite("__todo__", signal);
      }
      const key = resourceKey(call, ctx.workspace);
      if (key === "") return () => {};
      const tool = toolMap.get(call.name);
      const readOnly = tool?.annotations?.readOnlyHint === true;
      if (isMutation(call)) return lm.acquireWrite(key, signal);
      // Default unclassified path-bearing tools (including those without
      // annotations) to a write lock to avoid concurrent writes.
      if (readOnly !== true) {
        return lm.acquireWrite(key, signal);
      }
      return lm.acquireRead(key, signal);
    };

    let active = 0;
    const queue: Array<() => void> = [];
    function acquireSlot(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          const idx = queue.indexOf(resolveWrapped);
          if (idx >= 0) queue.splice(idx, 1);
          reject(new DOMException("aborted", "AbortError"));
        };
        const resolveWrapped = () => {
          signal.removeEventListener("abort", onAbort);
          active++;
          resolve();
        };
        if (active < maxParallel) {
          active++;
          resolve();
          return;
        }
        const wrapped = resolveWrapped;
        queue.push(wrapped);
        signal.addEventListener("abort", onAbort, { once: true });
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
        if (
          (ctx.mode as "plan" | "yolo" | undefined) === "plan" &&
          !isPlanToolAllowed(
            call.name,
            toolMap.get(call.name)?.annotations?.readOnlyHint === true,
          )
        ) {
          // Plan mode blocks the mutating built-ins. MCP and extension tools
          // are not built-ins, so they must either declare `readOnlyHint` or
          // are treated as mutating and blocked until the mode is lifted.
          results[i] = {
            toolCallId: call.id,
            name: call.name,
            content: "plan mode: tool disabled",
            isError: true,
          };
          return;
        }
        const permissionResult = await personaPermissionResult(call, ctx);
        if (permissionResult) {
          results[i] = permissionResult;
          return;
        }
        if (signal.aborted) {
          results[i] = {
            toolCallId: call.id,
            name: call.name,
            content: "USER_CANCELLED",
            isError: true,
          };
          return;
        }
        let release: Release | undefined;
        try {
          await acquireSlot(signal);
        } catch {
          results[i] = {
            toolCallId: call.id,
            name: call.name,
            content: "USER_CANCELLED",
            isError: true,
          };
          return;
        }
        try {
          release = await acquire(call);
          if (signal.aborted) {
            results[i] = {
              toolCallId: call.id,
              name: call.name,
              content: "USER_CANCELLED",
              isError: true,
            };
            return;
          }
          const tool = toolMap.get(call.name);
          if (!tool) {
            results[i] = {
              toolCallId: call.id,
              name: call.name,
              content: `TOOL_NOT_FOUND: ${call.name}`,
              isError: true,
            };
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
