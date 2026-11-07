import { createHash } from "node:crypto";
import { McpClient } from "./client.js";
import { StdioTransport } from "./stdio-transport.js";
import type {
  McpCallResult,
  McpEvent,
  McpRemoteTool,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpToolState,
  McpTransport,
  McpTransportCloseInfo,
  McpTransportFactory,
} from "./types.js";

const MAX_TOOL_NAME_LENGTH = 64;

/** Sanitise one name segment to the character set tool APIs accept. */
export function sanitizeNameSegment(value: string, fallback = "tool"): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function bounded(name: string): string {
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = shortHash(name);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1).replace(/_+$/, "")}_${hash}`;
}

/**
 * Resolve a remote tool to its model-facing name. The server and tool segments
 * are sanitised and the whole name is capped so it stays valid everywhere.
 */
export function namespacedToolName(server: string, tool: string): string {
  return bounded(
    `mcp__${sanitizeNameSegment(server, "server")}__${sanitizeNameSegment(tool)}`,
  );
}

export interface McpManagerOptions {
  servers?: Record<string, McpServerConfig>;
  transportFactory?: McpTransportFactory;
  onEvent?: (event: McpEvent) => void;
}

interface ServerRecord {
  name: string;
  config: McpServerConfig;
  state: McpServerState;
  client?: McpClient;
  transport?: McpTransport;
  remoteTools: McpRemoteTool[];
  lastError?: string;
  failedReported: boolean;
  connectPromise?: Promise<void>;
  refreshPromise?: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultTransportFactory(
  _serverName: string,
  config: McpServerConfig,
): McpTransport {
  return new StdioTransport(config);
}

/**
 * Owns the lifetime of every configured MCP server. Connections are lazy,
 * failures are isolated per server, and every state transition is observable.
 */
export class McpManager {
  onToolsChanged?: (tools: McpToolState[]) => void;
  private readonly records: Map<string, ServerRecord>;
  private readonly transportFactory: McpTransportFactory;
  private readonly onEvent?: (event: McpEvent) => void;
  private closed = false;

  constructor(options: McpManagerOptions = {}) {
    this.records = new Map();
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
    this.onEvent = options.onEvent;
    for (const [name, config] of Object.entries(options.servers ?? {})) {
      this.records.set(name, {
        name,
        config,
        state: config.enabled ? "idle" : "disabled",
        remoteTools: [],
        failedReported: false,
      });
    }
  }

  /** Configured server names, including disabled entries. */
  serverNames(): string[] {
    return [...this.records.keys()];
  }

  /** True when there is at least one enabled server. */
  hasEnabledServers(): boolean {
    return [...this.records.values()].some((record) => record.config.enabled);
  }

  status(): McpServerStatus[] {
    const namesByRemote = new Map(
      this.tools().map((tool) => [
        `${tool.server}\u0000${tool.remoteName}`,
        tool.name,
      ]),
    );
    return [...this.records.values()].map((record) => ({
      name: record.name,
      state: record.state,
      enabled: record.config.enabled,
      requiresApproval: record.config.requiresApproval,
      toolCount: record.state === "ready" ? record.remoteTools.length : 0,
      tools:
        record.state === "ready"
          ? record.remoteTools.map(
              (tool) =>
                namesByRemote.get(`${record.name}\u0000${tool.name}`) ??
                namespacedToolName(record.name, tool.name),
            )
          : [],
      lastError: record.lastError,
    }));
  }

  /** Discovered tools across every ready server. */
  tools(): McpToolState[] {
    const tools: McpToolState[] = [];
    const used = new Set<string>();
    for (const record of this.records.values()) {
      if (record.state !== "ready") continue;
      for (const remote of record.remoteTools) {
        const name = this.uniqueName(record.name, remote.name, used);
        tools.push({
          server: record.name,
          remoteName: remote.name,
          name,
          description:
            remote.description ?? `MCP tool ${remote.name} from ${record.name}`,
          inputSchema: remote.inputSchema ?? {
            type: "object",
            properties: {},
          },
          requiresApproval: record.config.requiresApproval,
          callTimeoutMs: record.config.callTimeoutMs,
        });
      }
    }
    return tools;
  }

  /**
   * Connect every idle server and return the current tool list. A failing
   * server is recorded and skipped; it never rejects the overall discovery.
   */
  async syncTools(): Promise<McpToolState[]> {
    if (this.closed) return [];
    const pending: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (!record.config.enabled) continue;
      if (record.state === "idle") pending.push(this.connect(record.name));
    }
    await Promise.all(pending);
    return this.tools();
  }

  /** Retry one server, or every server when no name is given. */
  async reconnect(name?: string): Promise<McpServerStatus[]> {
    if (this.closed) throw new Error("MCP manager is closed");
    if (name !== undefined) {
      if (!this.records.has(name)) {
        throw new Error(`Unknown MCP server: ${name}`);
      }
      await this.reset(this.records.get(name)!);
      if (this.records.get(name)!.config.enabled) {
        await this.connect(name);
      }
      return this.status();
    }
    for (const record of this.records.values()) {
      await this.reset(record);
    }
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.config.enabled)
        .map((record) => this.connect(record.name)),
    );
    return this.status();
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpCallResult> {
    const record = this.records.get(server);
    if (!record) throw new Error(`Unknown MCP server: ${server}`);
    if (record.state !== "ready" || !record.client) {
      throw new Error(
        `MCP_SERVER_UNAVAILABLE: ${server} is ${record.state}${
          record.lastError ? ` (${record.lastError})` : ""
        }`,
      );
    }
    if (options.signal?.aborted) throw new Error("USER_CANCELLED");
    const result = await record.client.callTool(tool, args, {
      timeoutMs: record.config.callTimeoutMs,
      signal: options.signal,
    });
    if (typeof result === "object" && result !== null) {
      return result as McpCallResult;
    }
    return { content: result };
  }

  /** Close every server without reporting failures. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.records.values()];
    for (const record of records) {
      record.state = "closed";
    }
    await Promise.all(
      records.map(async (record) => {
        const client = record.client;
        record.client = undefined;
        record.transport = undefined;
        await client?.close().catch(() => {});
        return undefined;
      }),
    );
  }

  /** Internal: establish one server and cache its tools. */
  private async connect(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record || this.closed || !record.config.enabled) return;
    if (record.state === "ready") return;
    if (record.connectPromise) return record.connectPromise;

    record.connectPromise = (async () => {
      record.state = "connecting";
      record.lastError = undefined;
      const transport = this.transportFactory(name, record.config);
      const client = new McpClient(transport, {
        onClose: (info) => this.handleUnexpectedClose(record, info),
      });
      record.transport = transport;
      record.client = client;
      client.onNotification("notifications/tools/list_changed", () => {
        void this.refresh(name);
      });

      try {
        await client.connect({
          startupTimeoutMs: record.config.startupTimeoutMs,
        });
        const remoteTools = await client.listTools({
          timeoutMs: record.config.callTimeoutMs,
        });
        if (this.closed || record.client !== client) {
          await client.close().catch(() => {});
          return;
        }
        record.remoteTools = remoteTools;
        record.state = "ready";
        record.failedReported = false;
        record.lastError = undefined;
        this.emit({
          type: "mcp_server_connected",
          server: name,
          toolCount: remoteTools.length,
        });
        this.emitToolsChanged();
      } catch (error) {
        if (this.closed || record.client !== client) {
          await client.close().catch(() => {});
          return;
        }
        this.fail(record, error, transport);
        await client.close().catch(() => {});
        if (record.client === client) {
          record.client = undefined;
          record.transport = undefined;
        }
      } finally {
        record.connectPromise = undefined;
      }
    })();

    return record.connectPromise;
  }

  private async refresh(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record || this.closed || record.state !== "ready") return;
    if (record.refreshPromise) return record.refreshPromise;
    const client = record.client;
    if (!client) return;
    record.refreshPromise = (async () => {
      try {
        const remoteTools = await client.listTools({
          timeoutMs: record.config.callTimeoutMs,
        });
        if (record.client !== client) return;
        record.remoteTools = remoteTools;
        record.lastError = undefined;
        this.emit({
          type: "mcp_tools_changed",
          server: name,
          toolCount: remoteTools.length,
        });
        this.emitToolsChanged();
      } catch (error) {
        if (record.client !== client) return;
        record.lastError = errorMessage(error);
        if (client.isClosed()) {
          this.fail(record, error, record.transport);
        }
      } finally {
        record.refreshPromise = undefined;
      }
    })();
    return record.refreshPromise;
  }

  private handleUnexpectedClose(
    record: ServerRecord,
    info: McpTransportCloseInfo,
  ): void {
    if (record.client && record.state !== "closed") {
      const detail =
        info.code !== undefined && info.code !== null
          ? `MCP server exited (code ${info.code})`
          : info.signal
            ? `MCP server exited (signal ${info.signal})`
            : "MCP server exited";
      record.lastError = detail;
      this.fail(record, new Error(detail), record.transport);
    }
  }

  private fail(
    record: ServerRecord,
    error: unknown,
    transport: McpTransport | undefined,
  ): void {
    record.state = "failed";
    record.remoteTools = [];
    const stderr = transport?.stderrText?.();
    const message = errorMessage(error);
    record.lastError =
      stderr && !message.includes(stderr)
        ? `${message}: ${stderr.slice(-2000)}`
        : message;
    if (!record.failedReported) {
      record.failedReported = true;
      this.emit({
        type: "mcp_server_failed",
        server: record.name,
        error: record.lastError,
      });
    }
    this.emitToolsChanged();
  }

  private async reset(record: ServerRecord): Promise<void> {
    const client = record.client;
    record.client = undefined;
    record.transport = undefined;
    record.connectPromise = undefined;
    record.refreshPromise = undefined;
    await client?.close().catch(() => {});
    record.remoteTools = [];
    record.lastError = undefined;
    record.failedReported = false;
    record.state = record.config.enabled ? "idle" : "disabled";
    this.emitToolsChanged();
  }

  private uniqueName(server: string, tool: string, used: Set<string>): string {
    const base = namespacedToolName(server, tool);
    let name = base;
    if (used.has(name)) {
      const hash = shortHash(`${server}\0${tool}`);
      name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1).replace(/_+$/, "")}_${hash}`;
    }
    used.add(name);
    return name;
  }

  private emitToolsChanged(): void {
    try {
      this.onToolsChanged?.(this.tools());
    } catch {
      // Consumers must not break server lifecycle.
    }
  }

  private emit(event: McpEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observability must never break tool execution.
    }
  }
}
