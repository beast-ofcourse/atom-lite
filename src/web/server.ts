import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentRuntime } from "../agent/loop.js";
import type { AgentEvent } from "../agent/types.js";
import type { Session } from "../sessions/store.js";
import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalRequest,
} from "../runtime/approvals.js";

export interface WebServerOptions {
  runtime: AgentRuntime;
  session: Session;
  approvals: ApprovalContext;
  providerName: string;
  model: string;
  /** 0 (default) asks the OS for a free port. */
  port?: number;
  host?: string;
  /** Directory holding the static client. Defaults to the packaged `web/`. */
  clientDir?: string;
  /** Open the default browser once the server is listening. */
  openBrowser?: boolean;
}

export interface WebServerHandle {
  /** Browser URL, including the run token. */
  url: string;
  /** WebSocket URL, including the run token. */
  wsUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const TOKEN_PLACEHOLDER = "__ATOM_LITE_TOKEN__";
const COOKIE_NAME = "atom_lite_token";

/** The packaged static client, resolved relative to this module. */
export function defaultClientDir(): string {
  return fileURLToPath(new URL("../../web/", import.meta.url));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function requestToken(req: IncomingMessage, url: URL): string | undefined {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const header = req.headers["x-atom-lite-token"];
  if (typeof header === "string" && header) return header;
  return readCookie(req, COOKIE_NAME);
}

/**
 * Only requests that come from this machine may drive the agent. A page on
 * another origin must not be able to reach the server (localhost CSRF), and a
 * rebound DNS name must not slip past the Host check.
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host ?? "";
  const hostname = hostHeader.replace(/:\d+$/, "");
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (originHost !== "127.0.0.1" && originHost !== "localhost") return false;
  }
  return true;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServerHandle> {
  const token = randomBytes(24).toString("base64url");
  const host = options.host ?? "127.0.0.1";
  const clientDir = options.clientDir ?? defaultClientDir();
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();
  let controller: WebSocket | null = null;
  let turnRunning = false;
  const inputQueue: string[] = [];
  let closed = false;

  const broadcast = (message: unknown): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  const sendTo = (client: WebSocket, message: unknown): void => {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  };

  const emitEvent = (event: AgentEvent): void => {
    broadcast({ type: "event", event });
  };

  // The runtime reports everything through one event sink; the browser is the
  // second consumer of it (the TUI is the first).
  (
    options.runtime as unknown as { onEvent?: (e: AgentEvent) => void }
  ).onEvent = emitEvent;

  const runTurn = async (text: string): Promise<void> => {
    turnRunning = true;
    broadcast({ type: "turn_start" });
    try {
      await options.runtime.runAgentTurn(
        text,
        options.session,
        new AbortController().signal,
      );
    } catch (err) {
      broadcast({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      turnRunning = false;
      broadcast({ type: "turn_end" });
      const next = inputQueue.shift();
      if (next && !closed) void runTurn(next);
    }
  };

  const handleInput = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (turnRunning) {
      inputQueue.push(trimmed);
      broadcast({ type: "input_queued", text: trimmed });
      return;
    }
    void runTurn(trimmed);
  };

  // Approvals block the agent until a browser answers.
  options.approvals.handler = (request: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => {
      const id = randomUUID();
      pendingApprovals.set(id, resolve);
      broadcast({
        type: "approval_request",
        id,
        request: {
          command: request.command,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          sandboxed: request.sandboxed,
        },
      });
    });
  options.approvals.nonInteractive = false;

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden\n");
        return;
      }
      if (requestToken(req, url) !== token) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("missing or invalid token\n");
        return;
      }
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (name.includes("..") || name.includes("/")) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
        return;
      }
      try {
        const file = await readFile(join(clientDir, name));
        const isPage = name === "index.html";
        // The page and every asset it pulls in must carry the token: the
        // browser cannot be trusted to keep a cookie, and the token is what
        // stops another page on this machine from driving the agent.
        const body = isPage
          ? file
              .toString("utf8")
              .replaceAll(TOKEN_PLACEHOLDER, token)
              .replace(/(\/(?:app\.js|styles\.css))"/g, `$1?token=${token}"`)
          : file;
        const headers: Record<string, string> = {
          "content-type": MIME[extname(name)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        if (isPage) {
          headers["set-cookie"] =
            `${COOKIE_NAME}=${token}; Path=/; SameSite=Strict`;
        }
        res.writeHead(200, headers);
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (!isLocalRequest(req) || requestToken(req, url) !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    if (!controller) controller = ws;
    sendTo(ws, {
      type: "hello",
      sessionId: options.session.id,
      provider: options.providerName,
      model: options.model,
      readOnly: controller !== ws,
    });

    ws.on("message", (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendTo(ws, { type: "error", message: "malformed message" });
        return;
      }
      if (message?.type === "input") {
        if (controller && ws !== controller) {
          sendTo(ws, {
            type: "error",
            message: "this tab is a read-only viewer",
          });
          return;
        }
        handleInput(String(message.text ?? ""));
        return;
      }
      if (message?.type === "approval") {
        const resolve = pendingApprovals.get(String(message.id));
        if (!resolve) return;
        pendingApprovals.delete(String(message.id));
        const decision = String(message.decision);
        resolve(
          decision === "approve" || decision === "trust-session"
            ? decision
            : "deny",
        );
        return;
      }
      sendTo(ws, { type: "error", message: "unknown message type" });
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (controller === ws) {
        controller = [...clients][0] ?? null;
        for (const client of clients) {
          sendTo(client, {
            type: "control",
            readOnly: controller !== client,
          });
        }
      }
    });
  });

  const requestedPort = options.port ?? 0;
  const port = await listenWithFallback(httpServer, host, requestedPort);
  const url = `http://${host}:${port}/?token=${token}`;
  const wsUrl = `ws://${host}:${port}/?token=${token}`;

  if (options.openBrowser) {
    void openBrowser(url);
  }

  return {
    url,
    wsUrl,
    port,
    token,
    close: async () => {
      closed = true;
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // best effort
        }
      }
      clients.clear();
      for (const resolve of pendingApprovals.values()) resolve("deny");
      pendingApprovals.clear();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Listen on the requested port, walking forward when it is taken. A busy
 * port is not an error: the next free one is used and reported.
 */
async function listenWithFallback(
  server: import("node:http").Server,
  host: string,
  requestedPort: number,
): Promise<number> {
  const maxAttempts = requestedPort > 0 ? 20 : 1;
  let attempt = 0;
  for (;;) {
    const port = requestedPort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt + 1 >= maxAttempts) throw err;
      attempt++;
    }
  }
}

/** Best-effort browser launch; failure is not an error for the server. */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort
  }
}
