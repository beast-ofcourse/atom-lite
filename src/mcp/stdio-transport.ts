import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { terminateProcessTree } from "../security/process.js";
import type { McpServerConfig, McpTransport, McpTransportHandlers } from "./types.js";

const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Windows process bootstrap.
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "CommonProgramFiles",
  "CommonProgramW6432",
]);

const ENV_PREFIX_ALLOWLIST = ["LC_", "XDG_"];

/**
 * Build the deliberately small environment inherited by an MCP server. The
 * provider API keys in the parent process are not part of the allowlist, so a
 * server only receives secrets the user explicitly declared.
 */
export function buildMcpEnv(
  declared: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (
      ENV_ALLOWLIST.has(key) ||
      ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(declared)) {
    env[key] = value;
  }
  return env;
}

const MAX_STDERR_BYTES = 8192;

/**
 * MCP stdio framing: one JSON-RPC message per newline. stderr is captured for
 * diagnostics but never mixed into the protocol stream.
 */
export class StdioTransport implements McpTransport {
  private readonly config: McpServerConfig;
  private handlers?: McpTransportHandlers;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private startPromise?: Promise<void>;
  private closing = false;
  private stderrBuffer = "";

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  setHandlers(handlers: McpTransportHandlers): void {
    this.handlers = handlers;
  }

  stderrText(): string {
    return this.stderrBuffer.trim();
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.config.command, this.config.args ?? [], {
          cwd: this.config.cwd,
          env: buildMcpEnv(this.config.env ?? {}),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;

      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          this.handlers?.onError(error);
        }
      });
      child.once("close", (code, signal) => {
        this.lines?.close();
        this.lines = undefined;
        this.child = undefined;
        if (!this.closing) {
          this.handlers?.onClose({ code, signal });
        }
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderrBuffer += chunk.toString();
        if (this.stderrBuffer.length > MAX_STDERR_BYTES) {
          this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_BYTES);
        }
      });

      this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.lines.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          this.handlers?.onMessage(JSON.parse(trimmed));
        } catch {
          this.handlers?.onError(
            new Error(`MCP server sent invalid JSON: ${trimmed.slice(0, 200)}`),
          );
        }
      });
    });
    return this.startPromise;
  }

  send(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("MCP server stdin is not available");
    }
    stdin.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // Ignore.
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    terminateProcessTree(child, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
        resolve();
      }, 750);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
