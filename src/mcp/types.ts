import type { McpServerConfig } from "../config/schema.js";

export type { McpServerConfig };

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export interface McpTransportCloseInfo {
  code?: number | null;
  signal?: string | null;
}

export interface McpTransportHandlers {
  onMessage(message: unknown): void;
  onError(error: Error): void;
  onClose(info: McpTransportCloseInfo): void;
}

/** A bidirectional JSON-RPC carrier. Tests inject a fake; production uses stdio. */
export interface McpTransport {
  start(): Promise<void>;
  send(message: unknown): void;
  close(): void | Promise<void>;
  setHandlers(handlers: McpTransportHandlers): void;
  /** Optional diagnostic text (stderr) for connection failures. */
  stderrText?(): string;
}

export type McpTransportFactory = (
  serverName: string,
  config: McpServerConfig,
) => McpTransport;

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A discovered tool after namespacing and policy decoration. */
export interface McpToolState {
  server: string;
  remoteName: string;
  /** Namespaced model-facing name: `mcp__<server>__<tool>`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  callTimeoutMs: number;
}

export type McpServerState =
  "disabled" | "idle" | "connecting" | "ready" | "failed" | "closed";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  enabled: boolean;
  requiresApproval: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
}

export type McpEvent =
  | {
      type: "mcp_server_connected";
      server: string;
      toolCount: number;
    }
  | {
      type: "mcp_server_failed";
      server: string;
      error: string;
    }
  | {
      type: "mcp_tools_changed";
      server: string;
      toolCount: number;
    };

export interface McpCallResult {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}
