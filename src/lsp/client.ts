import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspDiagnostic, LspServerInfo } from "./types.js";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface OpenDocument {
  version: number;
  text: string;
}

export class LspClient {
  private proc: ReturnType<typeof spawn>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private documents = new Map<string, OpenDocument>();
  private diagnosticsMap = new Map<string, LspDiagnostic[]>();
  ready: Promise<void>;
  readyResolved = false;
  private readySettled = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private exited = false;
  private shuttingDown = false;
  private diagnosticWaiters = new Map<string, Set<() => void>>();

  constructor(
    public readonly server: LspServerInfo,
    public readonly root: string,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.proc = spawn(server.command, server.args ?? [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.resume();
    this.proc.on("error", (err: Error) => this.handleProcessExit(err));
    this.proc.on("exit", (code, signal) => {
      this.handleProcessExit(
        new Error(
          `LSP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
    void this.initialize();
  }

  private handleProcessExit(err: Error): void {
    if (this.exited || this.shuttingDown) return;
    this.exited = true;
    this.readyResolved = false;
    if (!this.readySettled) {
      this.readySettled = true;
      try {
        this.readyReject(err);
      } catch {
        // ignore
      }
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    // Release any waiting diagnostics callers.
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const w of waiters) w();
    }
    this.diagnosticWaiters.clear();
  }

  private writeMessage(message: unknown): void {
    if (this.exited) return;
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      const json = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
      stdin.write(header + json, "utf8");
    } catch {
      // Best effort; request will time out if write failed.
    }
  }

  private sendRequest(method: string, params: unknown): Promise<any> {
    if (this.exited) {
      return Promise.reject(new Error("LSP process is not running"));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage(message);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number, result: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private onData(chunk: Buffer): void {
    if (this.exited) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isFinite(length) || length < 0) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer
        .slice(bodyStart, bodyStart + length)
        .toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + length);
      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // Ignore malformed frames.
      }
    }
  }

  private handleMessage(message: any): void {
    if (!message || typeof message !== "object") return;

    if (
      message.id !== undefined &&
      !message.method &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      if (typeof uri === "string") {
        const filePath = path.resolve(uriToPath(uri));
        const diags = Array.isArray(message.params?.diagnostics)
          ? message.params.diagnostics
          : [];
        this.diagnosticsMap.set(filePath, diags);
        const waiters = this.diagnosticWaiters.get(filePath);
        if (waiters) {
          for (const w of waiters) w();
          waiters.clear();
        }
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      if (message.method === "workspace/configuration") {
        const items = Array.isArray(message.params?.items)
          ? message.params.items
          : [];
        this.respond(
          message.id,
          items.map(() => this.server.initialization ?? {}),
        );
        return;
      }
      if (message.method === "workspace/workspaceFolders") {
        this.respond(message.id, [
          { name: "workspace", uri: pathToFileURL(this.root).href },
        ]);
        return;
      }
      if (message.method === "window/workDoneProgress/create") {
        this.respond(message.id, null);
        return;
      }
      if (message.method === "workspace/diagnostic/refresh") {
        this.respond(message.id, null);
        return;
      }
      this.respond(message.id, null);
    }
  }

  private async initialize(): Promise<void> {
    try {
      await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [
          { name: "workspace", uri: pathToFileURL(this.root).href },
        ],
        clientInfo: { name: "atom-lite", version: "0.1.0" },
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: { versionSupport: true },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            diagnostic: { refreshSupport: false },
          },
          window: { workDoneProgress: true },
        },
        initializationOptions: this.server.initialization ?? {},
      });
      this.sendNotification("initialized", {});
      this.readyResolved = true;
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyResolve();
      }
    } catch (err) {
      this.readyResolved = false;
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyReject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private resolved(filePath: string): string {
    return path.resolve(filePath);
  }

  async touchFile(filePath: string): Promise<void> {
    await this.ready;
    if (!this.readyResolved || this.exited) return;
    const resolvedPath = this.resolved(filePath);
    let text: string;
    try {
      text = await readFile(resolvedPath, "utf8");
    } catch {
      return;
    }
    const uri = pathToFileURL(resolvedPath).href;
    const languageId = languageIdForPath(resolvedPath);
    const existing = this.documents.get(resolvedPath);
    if (!existing) {
      this.diagnosticsMap.delete(resolvedPath);
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 0, text },
      });
      this.documents.set(resolvedPath, { version: 0, text });
    } else if (existing.text !== text) {
      this.diagnosticsMap.delete(resolvedPath);
      const version = existing.version + 1;
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      this.documents.set(resolvedPath, { version, text });
    }
  }

  async waitForDiagnostics(filePath: string, timeoutMs = 1000): Promise<void> {
    await this.ready;
    if (!this.readyResolved || this.exited) return;
    const resolvedPath = this.resolved(filePath);
    if (this.diagnosticsMap.has(resolvedPath)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const waiters = this.diagnosticWaiters.get(resolvedPath);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.diagnosticWaiters.delete(resolvedPath);
        }
        resolve();
      };
      const waiter = () => finish();
      let waiters = this.diagnosticWaiters.get(resolvedPath);
      if (!waiters) {
        waiters = new Set();
        this.diagnosticWaiters.set(resolvedPath, waiters);
      }
      waiters.add(waiter);
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
    });
  }

  diagnostics(filePath?: string): Map<string, LspDiagnostic[]> {
    if (filePath) {
      const resolvedPath = this.resolved(filePath);
      const result = new Map<string, LspDiagnostic[]>();
      result.set(resolvedPath, this.diagnosticsMap.get(resolvedPath) ?? []);
      return result;
    }
    return new Map(this.diagnosticsMap);
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    await this.touchFile(filePath);
    if (!this.readyResolved || this.exited) return null;
    const resolvedPath = this.resolved(filePath);
    const uri = pathToFileURL(resolvedPath).href;
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: {
        line: Math.max(0, line - 1),
        character: Math.max(0, character - 1),
      },
    });
  }

  async references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    await this.touchFile(filePath);
    if (!this.readyResolved || this.exited) return null;
    const resolvedPath = this.resolved(filePath);
    const uri = pathToFileURL(resolvedPath).href;
    return this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: {
        line: Math.max(0, line - 1),
        character: Math.max(0, character - 1),
      },
      context: { includeDeclaration: true },
    });
  }

  async documentSymbols(filePath: string): Promise<unknown> {
    await this.touchFile(filePath);
    if (!this.readyResolved || this.exited) return null;
    const resolvedPath = this.resolved(filePath);
    const uri = pathToFileURL(resolvedPath).href;
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  async workspaceSymbols(query: string): Promise<unknown> {
    await this.ready;
    if (!this.readyResolved || this.exited) return null;
    return this.sendRequest("workspace/symbol", { query });
  }

  async shutdown(): Promise<void> {
    if (this.exited || this.shuttingDown) return;
    this.shuttingDown = true;
    // Release any waiting diagnostics callers.
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const w of waiters) w();
    }
    this.diagnosticWaiters.clear();
    try {
      if (this.readyResolved) {
        await this.sendRequest("shutdown", null).catch(() => {});
        this.sendNotification("exit", null);
      } else {
        console.error("NOT_READY");
      }
    } catch {
      // Best effort.
    }
    this.exited = true;
    this.readyResolved = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error("LSP process is not running"));
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    try {
      this.proc.kill();
    } catch {
      // Best effort.
    }
  }
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri;
    }
  }
}

function languageIdForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".mts": "typescript",
    ".cts": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? "plaintext";
}
