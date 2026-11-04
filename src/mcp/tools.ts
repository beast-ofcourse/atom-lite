import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { ToolCall } from "../types.js";
import { checkApproval } from "../runtime/approvals.js";
import type { McpManager } from "./manager.js";
import type { McpToolState } from "./types.js";

export const MCP_APPROVAL_REQUIRED = "MCP_APPROVAL_REQUIRED";
export const MCP_CALL_FAILED = "MCP_CALL_FAILED";
export const MCP_APPROVAL_PREFIX = "mcp";

/**
 * Wrap one discovered MCP tool as an Atom-lite `Tool`. The execution path is
 * the same as built-ins: it receives the normal context, honours approval
 * policy, and returns the normal result shape.
 */
export class McpTool implements Tool {
  readonly definition: Tool["definition"];

  constructor(
    private readonly manager: McpManager,
    private readonly tool: McpToolState,
  ) {
    this.definition = {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    };
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const current = this.manager
      .tools()
      .find(
        (t) =>
          t.server === this.tool.server &&
          t.remoteName === this.tool.remoteName,
      );
    const requiresApproval =
      current?.requiresApproval ?? this.tool.requiresApproval;
    const callTimeoutMs =
      current?.callTimeoutMs ?? this.tool.callTimeoutMs;

    if (requiresApproval) {
      const approvals = ctx.approvals;
      const request = {
        command: `${MCP_APPROVAL_PREFIX} ${this.tool.server}/${this.tool.remoteName} ${JSON.stringify(args)}`,
        cwd: ctx.workspace,
        timeoutMs: callTimeoutMs,
        sandboxed: true,
      };
      if (!approvals) {
        return {
          toolCallId: call.id,
          name: this.tool.name,
          content: `${MCP_APPROVAL_REQUIRED}: approvals unavailable`,
          isError: true,
        };
      }
      const decision = await checkApproval(approvals, request);
      if (!decision.allowed) {
        return {
          toolCallId: call.id,
          name: this.tool.name,
          content: `${MCP_APPROVAL_REQUIRED}: ${this.tool.server}/${this.tool.remoteName}`,
          isError: true,
        };
      }
    }

    try {
      const result = await this.manager.callTool(
        this.tool.server,
        this.tool.remoteName,
        args,
        { signal: ctx.signal },
      );
      return {
        toolCallId: call.id,
        name: this.tool.name,
        content: summariseMcpResult(result),
        isError: Boolean(result?.isError),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (message === "USER_CANCELLED") {
        return {
          toolCallId: call.id,
          name: this.tool.name,
          content: "USER_CANCELLED",
          isError: true,
        };
      }
      return {
        toolCallId: call.id,
        name: this.tool.name,
        content: `${MCP_CALL_FAILED}: ${message}`,
        isError: true,
      };
    }
  }
}

export function createMcpTools(manager: McpManager): Tool[] {
  return manager.tools().map((tool) => new McpTool(manager, tool));
}

/** Map an MCP tool result into the single string Atom-lite tools use. */
export function summariseMcpResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result !== "object") return String(result);
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const parts = record.content.map((part) => {
      if (!part || typeof part !== "object") return String(part);
      const typed = part as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") {
        return typed.text;
      }
      if (typed.type === "image") {
        const mime =
          typeof typed.mimeType === "string" ? typed.mimeType : "image";
        const bytes = byteLengthOf(typed.data);
        return `[${mime} ${bytes} bytes]`;
      }
      if (typed.type === "audio") {
        const mime =
          typeof typed.mimeType === "string" ? typed.mimeType : "audio";
        const bytes = byteLengthOf(typed.data);
        return `[${mime} ${bytes} bytes]`;
      }
      if (typed.type === "resource") {
        const resource = typed.resource;
        if (resource && typeof resource === "object") {
          const r = resource as Record<string, unknown>;
          const mime =
            typeof r.mimeType === "string" ? r.mimeType : "resource";
          const bytes = byteLengthOf(r.blob);
          return `[${mime} ${bytes} bytes]`;
        }
        return "[resource]";
      }
      if (typed.type === "resource_link") {
        return typeof typed.uri === "string"
          ? `[resource_link ${typed.uri}]`
          : "[resource_link]";
      }
      if (typeof typed.type === "string") {
        const mime =
          typeof typed.mimeType === "string" ? typed.mimeType : typed.type;
        const bytes = byteLengthOf(typed.data ?? typed.blob);
        if (bytes > 0) return `[${mime} ${bytes} bytes]`;
        return `[${typed.type}]`;
      }
      return `[${JSON.stringify(typed).slice(0, 120)}]`;
    });
    return parts.join("\n").trim();
  }
  if (typeof record.result === "string") return record.result;
  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

function byteLengthOf(value: unknown): number {
  if (typeof value === "string") {
    // MCP image/audio data is base64.
    try {
      return Buffer.byteLength(value, "base64");
    } catch {
      return Buffer.byteLength(value, "utf8");
    }
  }
  if (value instanceof Uint8Array) return value.byteLength;
  return 0;
}
