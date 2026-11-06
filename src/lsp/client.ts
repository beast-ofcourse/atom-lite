import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  private ready: Promise<void>;
  private readyResolved = false;

  constructor(
    public readonly server: LspServerInfo,
    public readonly root: string,
  ) {
    this.proc = spawn(server.command, server.args ?? [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.resume();
    this.ready = this.initialize();
  }

  private writeMessage(message: unknown): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    this.proc.stdin?.write(header + json, "utf8");
  }

  private sendRequest(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number, result: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private onData(chunk: Buffer): void {
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
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString("utf8");
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
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      if (typeof uri === "string") {
        const filePath = uriToPath(uri);
        this.diagnosticsMap.set(filePath, message.params?.diagnostics ?? []);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      if (message.method === "workspace/configuration") {
        const items = message.params?.items ?? [];
        this.respond(
          message.id,
          items.map(() => this.server.initialization ?? {}),
        );
        return;
      }
      if (message.method === "workspace/workspaceFolders") {
        this.respond(message.id, [{ name: "workspace", uri: pathToFileURL(this.root).href }]);
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
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(this.root).href }],
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
    } catch {
      this.readyResolved = false;
    }
  }

  async touchFile(filePath: string): Promise<void> {
    await this.ready;
    if (!this.readyResolved) return;
    const text = readFileSync(filePath, "utf8");
    const uri = pathToFileURL(filePath).href;
    const languageId = languageIdForPath(filePath);
    const existing = this.documents.get(filePath);
    if (!existing) {
      this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 0, text },
      });
      this.documents.set(filePath, { version: 0, text });
    } else if (existing.text !== text) {
      const version = existing.version + 1;
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      this.documents.set(filePath, { version, text });
    }
  }

  async waitForDiagnostics(filePath: string, timeoutMs = 1000): Promise<void> {
    await this.ready;
    if (!this.readyResolved) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  diagnostics(filePath?: string): Map<string, LspDiagnostic[]> {
    if (filePath) {
      const result = new Map<string, LspDiagnostic[]>();
      result.set(filePath, this.diagnosticsMap.get(filePath) ?? []);
      return result;
    }
    return new Map(this.diagnosticsMap);
  }

  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    await this.touchFile(filePath);
    const uri = pathToFileURL(filePath).href;
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });
  }

  async references(filePath: string, line: number, character: number): Promise<unknown> {
    await this.touchFile(filePath);
    const uri = pathToFileURL(filePath).href;
    return this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      context: { includeDeclaration: true },
    });
  }

  async documentSymbols(filePath: string): Promise<unknown> {
    await this.touchFile(filePath);
    const uri = pathToFileURL(filePath).href;
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  async workspaceSymbols(query: string): Promise<unknown> {
    return this.sendRequest("workspace/symbol", { query });
  }

  async shutdown(): Promise<void> {
    try {
      await this.sendRequest("shutdown", null);
      this.sendNotification("exit", null);
    } catch {
      // Best effort.
    }
    try {
      this.proc.kill();
    } catch {
      // Best effort.
    }
  }
}

function uriToPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
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
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? "plaintext";
}