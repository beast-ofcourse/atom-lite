import type {
  JsonRpcId,
  JsonRpcMessage,
  McpRemoteTool,
  McpTransport,
} from "./types.js";
import type { JsonValue } from "../types.js";

import { VERSION } from "../version.js";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
] as const;

export const PREFERRED_PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export class McpNotConnectedError extends McpError {
  constructor(message = "MCP client is not connected") {
    super(message);
    this.name = "McpNotConnectedError";
  }
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  cleanupAbort?: () => void;
}

export interface McpClientOptions {
  clientName?: string;
  clientVersion?: string;
  /** Called when the transport closes unexpectedly (not via close()). */
  onClose?: (info: { code?: number | null; signal?: string | null }) => void;
}

export interface McpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpConnectOptions extends McpRequestOptions {
  /** Timeout for spawning the transport and completing the handshake. */
  startupTimeoutMs?: number;
}

export interface McpClientConnectResult {
  protocolVersion: string;
  serverInfo?: unknown;
  capabilities?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Small JSON-RPC 2.0 client for MCP. The transport owns framing and process
 * lifecycle; this class owns request ids, timeouts, cancellation, and
 * notifications.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly onClose?: McpClientOptions["onClose"];
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  private closed = false;
  private started = false;
  private startPromise?: Promise<void>;
  private protocolVersion?: string;
  private serverInfo?: unknown;
  private capabilities?: unknown;
  private lastTransportError?: Error;

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    this.transport = transport;
    this.clientName = options.clientName ?? "atom-lite";
    this.clientVersion = options.clientVersion ?? VERSION;
    this.onClose = options.onClose;
    transport.setHandlers({
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => this.handleTransportError(error),
      onClose: (info) => this.handleClose(info),
    });
  }

  get protocolVersionValue(): string | undefined {
    return this.protocolVersion;
  }

  get serverInfoValue(): JsonValue | undefined {
    return this.serverInfo as JsonValue | undefined;
  }

  get capabilitiesValue(): JsonValue | undefined {
    return this.capabilities as JsonValue | undefined;
  }

  get lastError(): Error | undefined {
    return this.lastTransportError;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Spawn the transport and perform the MCP initialize handshake. */
  async connect(
    options: McpConnectOptions = {},
  ): Promise<McpClientConnectResult> {
    if (this.closed) throw new McpNotConnectedError();
    if (!this.started) {
      this.started = true;
      this.startPromise = (async () => {
        await this.transport.start();
      })();
      try {
        await raceTimeout(
          this.startPromise,
          options.startupTimeoutMs,
          "MCP transport start",
        );
      } catch (error) {
        await this.close();
        throw error;
      }
    } else if (this.startPromise) {
      await this.startPromise;
    }

    const result = await this.request(
      "initialize",
      {
        protocolVersion: PREFERRED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
      },
      {
        timeoutMs: options.startupTimeoutMs,
        signal: options.signal,
      },
    );

    if (!isRecord(result)) {
      throw new McpError("MCP initialize returned an invalid result");
    }
    const protocolVersion =
      typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    if (
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
        protocolVersion,
      )
    ) {
      throw new McpError(
        `Unsupported MCP protocol version: ${protocolVersion || "(missing)"}`,
      );
    }

    this.protocolVersion = protocolVersion;
    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities;
    this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    return {
      protocolVersion,
      serverInfo: this.serverInfo,
      capabilities: this.capabilities,
    };
  }

  /** Discover every page of tools/list. */
  async listTools(options: McpRequestOptions = {}): Promise<McpRemoteTool[]> {
    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        options,
      );
      if (!isRecord(result)) {
        throw new McpError("tools/list returned an invalid result");
      }
      const list = Array.isArray(result.tools) ? result.tools : [];
      for (const raw of list) {
        if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) {
          continue;
        }
        tools.push({
          name: raw.name,
          description:
            typeof raw.description === "string" ? raw.description : undefined,
          inputSchema: isRecord(raw.inputSchema)
            ? (raw.inputSchema as Record<string, unknown>)
            : undefined,
        });
      }
      if (typeof result.nextCursor === "string" && result.nextCursor) {
        cursor = result.nextCursor;
      } else {
        break;
      }
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, options);
  }

  async ping(options: McpRequestOptions = {}): Promise<unknown> {
    return this.request("ping", {}, options);
  }

  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  async request(
    method: string,
    params: unknown,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) throw new McpNotConnectedError();
    if (options.signal?.aborted) throw new Error("USER_CANCELLED");

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
      };

      const finish = (): void => {
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = undefined;
        }
        pending.cleanupAbort?.();
        pending.cleanupAbort = undefined;
        this.pending.delete(id);
      };

      const fail = (error: Error): void => {
        finish();
        reject(error);
      };

      const cancel = (reason: string): void => {
        this.sendNotification("notifications/cancelled", {
          requestId: id,
          reason,
        });
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          cancel("timeout");
          fail(
            new McpError(`${method} timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
      }

      if (options.signal) {
        const onAbort = (): void => {
          cancel("cancelled");
          fail(new Error("USER_CANCELLED"));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending.set(id, pending);
      try {
        this.transport.send({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      } catch (error) {
        fail(new McpError(`Failed to send ${method}: ${errorMessage(error)}`));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new McpNotConnectedError("MCP client closed");
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
      this.pending.delete(id);
    }
    try {
      await this.transport.close();
    } catch {
      // Shutdown is best effort.
    }
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.closed) return;
    try {
      this.transport.send({ jsonrpc: "2.0", method, params });
    } catch {
      // A failing cancel notification must not mask the original failure.
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.handleTransportError(new McpError("Invalid JSON-RPC message"));
      return;
    }

    // Response to one of our requests.
    if (
      "id" in message &&
      !("method" in message) &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(message.id as JsonRpcId);
      if (!pending) return;
      this.pending.delete(message.id as JsonRpcId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      if (isRecord(message.error)) {
        pending.reject(
          new McpError(
            typeof message.error.message === "string"
              ? message.error.message
              : `${pending.method} failed`,
            typeof message.error.code === "number"
              ? message.error.code
              : undefined,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated request. Atom-lite does not advertise roots, sampling,
    // or elicitation, so reject unknown requests with JSON-RPC method-not-found.
    if ("id" in message && typeof message.method === "string") {
      try {
        this.transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      } catch {
        // Ignore.
      }
      return;
    }

    if (typeof message.method === "string") {
      const handlers = this.notificationHandlers.get(message.method);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(message.params);
        } catch {
          // A notification handler must not break the transport loop.
        }
      }
    }
  }

  private handleTransportError(error: Error): void {
    this.lastTransportError = error;
  }

  private handleClose(info: {
    code?: number | null;
    signal?: string | null;
  }): void {
    if (this.closed) return;
    this.closed = true;
    const detail =
      info.code !== undefined && info.code !== null
        ? ` (code ${info.code})`
        : info.signal
          ? ` (signal ${info.signal})`
          : "";
    const error = new McpError(`MCP server exited${detail}`);
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.cleanupAbort?.();
      pending.reject(error);
      this.pending.delete(id);
    }
    this.onClose?.(info);
  }
}
