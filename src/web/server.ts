import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentRuntime } from "../agent/loop.js";
import type { AgentEvent } from "../agent/types.js";
import {
  InMemorySession,
  type JsonlSessionStore,
  type Session,
} from "../sessions/store.js";
import type { SessionEvent } from "../sessions/events.js";
import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalRequest,
} from "../runtime/approvals.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionListing,
} from "./protocol.js";

export interface WebServerOptions {
  runtime: AgentRuntime;
  /** Session the server starts on. */
  session: Session;
  approvals: ApprovalContext;
  providerName: string;
  model: string;
  /** Durable store backing list / resume / new. */
  store?: JsonlSessionStore;
  /** Workspace that scopes session listings; defaults to the session's. */
  workspace?: string;
  /** 0 (default) asks the OS for a free port. */
  port?: number;
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
function defaultClientDir(): string {
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

interface PendingApproval {
  turnId: number;
  message: ServerMessage;
  resolve: (decision: ApprovalDecision) => void;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServerHandle> {
  const token = randomBytes(24).toString("base64url");
  const host = "127.0.0.1";
  const clientDir = defaultClientDir();
  const workspace = options.workspace ?? options.session.workspace;
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const steeringQueue: string[] = [];
  let session = options.session;
  let controller: WebSocket | null = null;
  let turnRunning = false;
  let turnCounter = 0;

  options.runtime.setSteeringQueue(steeringQueue);

  const broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  const sendTo = (client: WebSocket, message: ServerMessage): void => {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  };

  const emitEvent = (event: AgentEvent): void => {
    broadcast({ type: "event", event });
  };

  // The runtime reports everything through one event sink; the browser is the
  // consumer of it in serve mode (the TUI is the consumer in interactive mode).
  options.runtime.setEventSink(emitEvent);

  const historyOf = (target: Session): SessionEvent[] => target.events;

  const listSessions = (): SessionListing[] =>
    options.store?.listSessions(workspace) ?? [];

  const denyPendingApprovals = (): void => {
    for (const pending of pendingApprovals.values()) pending.resolve("deny");
    pendingApprovals.clear();
  };

  const runTurn = async (initial: string): Promise<void> => {
    turnRunning = true;
    const controllerAbort = new AbortController();
    broadcast({ type: "turn_start", turnId: ++turnCounter });
    let next: string | undefined = initial;
    try {
      while (next !== undefined) {
        await options.runtime.runAgentTurn(
          next,
          session,
          controllerAbort.signal,
        );
        // Flush before the next queue check: input that arrives while the
        // write is in flight is still picked up below, not stranded behind
        // turn_end.
        await session.flush?.();
        // The runtime drains the steering queue between model iterations;
        // anything left arrived after the last drain. Treat it as another
        // turn so turn_end still means "everything sent belongs here".
        next = steeringQueue.shift();
      }
    } catch (err) {
      // An aborted/failed turn cannot deliver its queued steering messages;
      // keeping them would inject text into a later turn or session.
      await session.flush?.();
      steeringQueue.length = 0;
      broadcast({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // No awaits between the final queue check and turn_end: a message
      // arriving after this point starts a new turn, never a stranded queue.
      turnRunning = false;
      broadcast({ type: "turn_end" });
    }
  };

  const handleInput = (client: WebSocket, text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Every tab sees the prompt, including viewer tabs that cannot send one.
    broadcast({ type: "user_input", text: trimmed });
    if (turnRunning) {
      steeringQueue.push(trimmed);
      // Only the sender needs the pending row.
      sendTo(client, { type: "input_queued", text: trimmed });
      return;
    }
    void runTurn(trimmed);
  };

  /**
   * Switch synchronously: a concurrent input after this call must start on
   * the new session, never on the outgoing one. The old log is flushed in the
   * background; every turn already flushed before turn_end.
   */
  const switchSession = (next: Session): void => {
    const previous = session;
    session = next;
    steeringQueue.length = 0;
    broadcast({
      type: "session_changed",
      sessionId: session.id,
      history: historyOf(session),
    });
    broadcast({ type: "sessions", sessions: listSessions() });
    void previous.flush?.();
  };

  /**
   * Sessions are workspace-scoped: a browser in one workspace must never be
   * offered (or able to resume) another workspace's transcript.
   */
  const resumeSession = (
    id: string,
  ): { session: Session } | { error: string } => {
    if (!options.store) return { error: "sessions are disabled" };
    const next = options.store.resume(id);
    if (!next) return { error: `no session ${id}` };
    if (next.workspace !== workspace) {
      return { error: "session belongs to another workspace" };
    }
    return { session: next };
  };

  const newSession = (): Session => {
    // Trust-for-session is per conversation, matching the terminal.
    options.approvals.resetTrust?.();
    return options.store
      ? options.store.create(workspace, options.providerName)
      : new InMemorySession(randomUUID(), workspace, options.providerName);
  };

  // Approvals block the agent until a browser answers. The id matches the
  // answer; the turn id proves which waiting turn it belongs to.
  options.approvals.handler = (request: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => {
      const id = randomUUID();
      const message: ServerMessage = {
        type: "approval_request",
        id,
        turnId: turnCounter,
        request: {
          command: request.command,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          sandboxed: request.sandboxed,
          tool: request.tool,
        },
      };
      pendingApprovals.set(id, { turnId: turnCounter, message, resolve });
      if (clients.size === 0) {
        // Nobody can answer; fail safe rather than strand the turn.
        pendingApprovals.delete(id);
        resolve("deny");
        return;
      }
      broadcast(message);
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

  const isController = (client: WebSocket): boolean =>
    controller === null || controller === client;

  /** Reject non-controlling tabs with the standard read-only error. */
  const requireController = (client: WebSocket): boolean => {
    if (isController(client)) return true;
    sendTo(client, {
      type: "error",
      message: "this tab is a read-only viewer",
    });
    return false;
  };

  /** Session switches race turns; refuse them until the turn ends. */
  const rejectWhileTurnRunning = (client: WebSocket): boolean => {
    if (!turnRunning) return false;
    sendTo(client, {
      type: "error",
      message: "cannot switch sessions while a turn is running",
    });
    return true;
  };

  const switchSessionIfIdle = (
    client: WebSocket,
    pick: () => { session: Session } | { error: string },
  ): void => {
    if (!requireController(client)) return;
    if (rejectWhileTurnRunning(client)) return;
    const result = pick();
    if ("error" in result) {
      sendTo(client, { type: "error", message: result.error });
      return;
    }
    switchSession(result.session);
  };

  const handleClientMessage = (
    client: WebSocket,
    message: ClientMessage,
  ): void => {
    switch (message.type) {
      case "input":
        if (!requireController(client)) return;
        handleInput(client, message.text);
        return;
      case "approval": {
        if (!requireController(client)) return;
        const pending = pendingApprovals.get(message.id);
        if (!pending) return;
        if (message.turnId !== undefined && message.turnId !== pending.turnId) {
          sendTo(client, {
            type: "error",
            message: "approval does not match the waiting turn",
          });
          return;
        }
        pendingApprovals.delete(message.id);
        pending.resolve(message.decision);
        return;
      }
      case "list_sessions":
        sendTo(client, { type: "sessions", sessions: listSessions() });
        return;
      case "new_session":
        switchSessionIfIdle(client, () => ({ session: newSession() }));
        return;
      case "resume_session":
        switchSessionIfIdle(client, () => resumeSession(message.id));
        return;
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    if (!controller) controller = ws;
    sendTo(ws, {
      type: "hello",
      sessionId: session.id,
      provider: options.providerName,
      model: options.model,
      readOnly: controller !== ws,
      history: historyOf(session),
    });

    ws.on("message", (data) => {
      const parsed = parseClientMessage(data.toString());
      if ("error" in parsed) {
        sendTo(ws, { type: "error", message: parsed.error });
        return;
      }
      handleClientMessage(ws, parsed.message);
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (controller === ws) {
        controller = [...clients][0] ?? null;
        for (const client of clients) {
          sendTo(client, { type: "control", readOnly: controller !== client });
        }
        // The new controller must be able to answer a request that was still
        // pending when control moved.
        if (controller) {
          for (const pending of pendingApprovals.values()) {
            sendTo(controller, pending.message);
          }
        }
      }
      if (clients.size === 0) denyPendingApprovals();
    });
  });

  const port = await listenWithFallback(httpServer, host, options.port ?? 0);
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
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // best effort
        }
      }
      clients.clear();
      denyPendingApprovals();
      options.runtime.setEventSink(undefined);
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
  server: Server,
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
