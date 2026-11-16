import { spawn, type ChildProcess } from "node:child_process";
import { terminateProcessTree } from "../security/process.js";

/** A published tunnel and the handle that owns its process. */
export interface TunnelHandle {
  /** Public HTTPS URL reported by the tunnel provider. */
  url: string;
  /** Terminate the tunnel process tree. Safe to call more than once. */
  close(): Promise<void>;
}

export interface TunnelOptions {
  /** Local port the tunnel forwards to. */
  port: number;
  /** Command template; `{port}` is replaced with the local port. */
  command?: string;
  /** How long to wait for the provider to publish a URL. */
  timeoutMs?: number;
  /** Called if the provider exits after publishing a URL. */
  onExit?: () => void;
  /** Cancels startup, for example on Ctrl-C. */
  signal?: AbortSignal;
}

export const DEFAULT_TUNNEL_COMMAND =
  "cloudflared tunnel --url http://127.0.0.1:{port}";

const ANSI = /\x1b\[[0-9;]*m/g;

/** Split a command into arguments without invoking a shell. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`unterminated ${quote} quote in tunnel command`);
  if (started) tokens.push(current);
  return tokens;
}

/** Extract the first usable HTTPS URL from provider output. */
export function extractTunnelUrl(output: string): string | undefined {
  const clean = output.replace(ANSI, "");
  const candidates = clean.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const urls: URL[] = [];
  for (const raw of candidates) {
    const trimmed = raw.replace(/[.,;:)\]]+$/, "");
    try {
      const url = new URL(trimmed);
      if (url.protocol === "https:" && url.hostname) urls.push(url);
    } catch {
      // Ignore text that only looks like a URL.
    }
  }
  // cloudflared also prints documentation links; its assigned hostname is
  // the one that matters when present.
  const assigned = urls.find((url) =>
    url.hostname.endsWith(".trycloudflare.com"),
  );
  const selected = assigned ?? urls[0];
  return selected ? selected.toString() : undefined;
}

/** Hostname used for the server's request allowlist. */
export function tunnelHostname(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start an outbound tunnel and wait until it publishes an HTTPS URL.
 * The child process is owned by the returned handle and killed on close.
 */
export async function startTunnel(
  options: TunnelOptions,
): Promise<TunnelHandle> {
  const template = (options.command ?? DEFAULT_TUNNEL_COMMAND).trim();
  const parts = tokenizeCommand(template);
  if (parts.length === 0) throw new Error("tunnel command is empty");
  const args = parts.map((part) =>
    part.replaceAll("{port}", String(options.port)),
  );
  const [executable, ...rest] = args;

  let child: ChildProcess;
  try {
    child = spawn(executable, rest, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `could not start tunnel command ${executable}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let settled = false;
  let closing = false;
  let output = "";
  const timeout = options.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    terminateProcessTree(child);
  };

  return await new Promise<TunnelHandle>((resolve, reject) => {
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      void close();
      const tail = output.trim().slice(-600);
      reject(new Error(tail ? `${message}\n${tail}` : message));
    };

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output = (output + text).slice(-64_000);
      const url = extractTunnelUrl(output);
      if (!url || settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      resolve({
        url,
        close,
      });
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) =>
      fail(`could not start ${executable}: ${err.message}`),
    );
    child.on("exit", (code) => {
      if (!settled) {
        fail(
          `tunnel command exited before publishing a URL (code ${code ?? "none"})`,
        );
      } else if (!closing) {
        options.onExit?.();
      }
    });

    onAbort = () => fail("tunnel startup cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(
      () => fail(`tunnel command did not publish a URL within ${timeout}ms`),
      timeout,
    );
  });
}
