import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
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
import { contentPartsText } from "../sessions/events.js";
import type {
  ApprovalContext,
  ApprovalDecision,
  ApprovalRequest,
} from "../runtime/approvals.js";
import type { QuestionContext, QuestionOutcome } from "../runtime/questions.js";
import type { GoalState } from "../runtime/goal.js";
import { isAndroid, pickNativeDirectory } from "./native-picker.js";
import {
  parseClientMessage,
  type ClientMessage,
  type DirectoryListing,
  type ServerMessage,
  type SessionListing,
  type WebAgent,
  type WebMcpServer,
  type WebModel,
  type WebSkill,
} from "./protocol.js";

export type WebModelSwitchResult =
  { provider: string; model: string; models?: WebModel[] } | { error: string };

export type WebAgentSwitchResult =
  { agent: string; agents: WebAgent[] } | { error: string };

export interface WebServerOptions {
  runtime: AgentRuntime;
  /** Session the server starts on. */
  session: Session;
  approvals: ApprovalContext;
  /** Question bridge shared with the runtime; the server installs a handler. */
  questions?: QuestionContext;
  providerName: string;
  model: string;
  /** Durable store backing list / resume / new. */
  store?: JsonlSessionStore;
  /** Workspace that scopes session listings; defaults to the session's. */
  workspace?: string;
  /** Web colour theme; the CLI maps config.ui.theme into this. */
  theme?: "light" | "dark";
  /** Provider/model pairs offered by the web picker. */
  models?: WebModel[];
  /** Switch the live runtime model; persistence belongs to the caller. */
  switchModel?: (
    provider: string,
    model: string,
  ) => WebModelSwitchResult | Promise<WebModelSwitchResult>;
  /** Active primary agent persona at startup. */
  agent?: string | null;
  /** Primary personas offered by the web agent overlay, scoped to a workspace. */
  agents?: (workspace: string) => WebAgent[];
  /** Switch the live runtime persona; refused while a turn is running. */
  switchAgent?: (
    name: string,
    workspace: string,
  ) => WebAgentSwitchResult | Promise<WebAgentSwitchResult>;
  /** Initial agent mode shown and switchable from the composer. */
  mode?: "plan" | "yolo";
  /** Initial thinking effort shown and switchable from the composer. */
  effort?: string;
  /** Apply a new plan/yolo mode to the live runtime. */
  setMode?: (mode: "plan" | "yolo") => void;
  /** Apply a new thinking effort to the live runtime. */
  setEffort?: (effort: string) => void;
  /** Fetch a live model list from every configured provider. */
  refreshModels?: () => Promise<WebModel[]>;
  /** Skills available to the runtime, for the /skills overlay. */
  skills?: (workspace: string) => WebSkill[];
  /** Live MCP server status, for the /mcp overlay. */
  mcpStatus?: () => WebMcpServer[];
  /** Connect or disconnect one configured MCP server for this process. */
  setMcpEnabled?: (
    name: string,
    enabled: boolean,
  ) => WebMcpServer[] | Promise<WebMcpServer[]>;
  /** Open the OS folder picker. Null means the user cancelled. */
  pickDirectory?: () => Promise<string | null>;
  /**
   * How long a pending approval waits for its client to come back before it
   * fails safe as a denial. Zero denies immediately.
   */
  approvalGraceMs?: number;
  /** Maximum concurrent browser connections. */
  maxClients?: number;
  /** Maximum size of one client WebSocket frame. */
  maxMessageBytes?: number;
  /** Approximate cap on the active-turn replay buffer. */
  maxReplayBytes?: number;
  /** 0 (default) asks the OS for a free port. */
  port?: number;
  /** Open the default browser once the server is listening. */
  openBrowser?: boolean;
  /** Interface to bind; defaults to loopback. Share mode uses 0.0.0.0. */
  bindHost?: string;
  /** Extra hostname accepted in Host and Origin checks, for share mode. */
  allowedHost?: string;
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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

const IMAGE_EXTENSIONS = new Set(
  Object.keys(MIME).filter(
    (ext) => ext.startsWith(".") && MIME[ext].startsWith("image/"),
  ),
);

const TOKEN_PLACEHOLDER = "__ATOM_LITE_TOKEN__";
const THEME_PLACEHOLDER = "__ATOM_LITE_THEME__";
const COOKIE_NAME = "atom_lite_token";

/**
 * Map a resolved UI theme name onto the web surface. Light, solarized, and
 * no-colour themes use the light web theme; everything else is dark.
 */
export function webThemeFor(themeName: string): "light" | "dark" {
  if (
    themeName === "light" ||
    themeName === "solarized" ||
    themeName === "ansi"
  ) {
    return "light";
  }
  return "dark";
}

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

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Only requests from the local machine or the one explicitly shared LAN
 * address may drive the agent. A foreign page must not be able to reach the
 * server (localhost CSRF), and a rebound DNS name must not slip past the Host
 * check.
 */
function createHostCheck(allowedHost?: string) {
  const extra = allowedHost ? normalizeHost(allowedHost) : "";
  return (req: IncomingMessage): boolean => {
    const hostname = normalizeHost(req.headers.host ?? "");
    if (
      hostname !== "127.0.0.1" &&
      hostname !== "localhost" &&
      hostname !== extra
    ) {
      return false;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = normalizeHost(new URL(origin).hostname);
      } catch {
        return false;
      }
      if (
        originHost !== "127.0.0.1" &&
        originHost !== "localhost" &&
        originHost !== extra
      ) {
        return false;
      }
    }
    return true;
  };
}

interface PendingApproval {
  turnId: number;
  message: ServerMessage;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingQuestion {
  turnId: number;
  message: ServerMessage;
  resolve: (outcome: QuestionOutcome) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServerHandle> {
  const token = randomBytes(24).toString("base64url");
  const host = options.bindHost ?? "127.0.0.1";
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const isAllowedRequest = createHostCheck(options.allowedHost);
  const clientDir = defaultClientDir();
  const theme = options.theme === "light" ? "light" : "dark";
  const maxClients = Math.max(1, options.maxClients ?? 32);
  // Attachments travel as base64 in one frame; 20 MB of file is ~27 MB of
  // text, so the default frame budget is larger than the text-only protocol.
  const maxMessageBytes = Math.max(1024, options.maxMessageBytes ?? 33_554_432);
  const maxReplayBytes = Math.max(1024, options.maxReplayBytes ?? 4_194_304);
  let workspace = options.workspace ?? options.session.workspace;
  let providerName = options.providerName;
  let currentModel = options.model;
  let currentMode: "plan" | "yolo" = options.mode ?? "yolo";
  let currentEffort = options.effort ?? "medium";
  let activeAgent = options.agent ?? options.runtime.getPersona()?.name ?? null;
  let models: WebModel[] =
    options.models && options.models.length > 0
      ? [...options.models]
      : [{ provider: providerName, model: currentModel }];
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const steeringQueue: string[] = [];
  let session = options.session;
  let controller: WebSocket | null = null;
  let turnRunning = false;
  let pickingWorkspace = false;
  let turnCounter = 0;
  let turnStartedAt = 0;
  let turnOutputTokens = 0;
  let turnModelMs = 0;
  // Everything a client that joins mid-turn needs to rebuild the active turn.
  // Released at turn_end; completed turns live in the session history.
  let turnEvents: AgentEvent[] = [];
  let turnSessionStart = 0;
  let turnInput = "";
  let approvalTimer: NodeJS.Timeout | undefined;
  let replayBytes = 0;
  let replayTruncated = false;
  let closing = false;
  let activeAbort: AbortController | undefined;
  let turnPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  /** Attachment paths waiting to be referenced by the next turn, per session. */
  const sessionAttachments = new Map<string, string[]>();

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
    if (event.type === "usage") {
      turnOutputTokens += event.output ?? 0;
      turnModelMs += event.elapsedMs ?? 0;
    }
    if (turnRunning) {
      // Bound the active-turn buffer: a single enormous turn must not grow
      // server memory without limit. Dropped events only affect live replay
      // detail; the session log still records messages and tool results.
      const text =
        "text" in event && typeof event.text === "string"
          ? event.text.length
          : 256;
      if (replayBytes + text <= maxReplayBytes) {
        turnEvents.push(event);
        replayBytes += text;
      } else {
        replayTruncated = true;
      }
    }
    broadcast({ type: "event", event });
  };

  // The runtime reports everything through one event sink; the browser is the
  // consumer of it in serve mode (the TUI is the consumer in interactive mode).
  options.runtime.setEventSink(emitEvent);

  const historyOf = (target: Session): SessionEvent[] => target.events;

  /** The last durable goal snapshot, read without copying the event log. */
  const goalOf = (target: Session): GoalState | null => {
    const events = target.events;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "goal_updated") {
        return (events[i].goal as GoalState | undefined) ?? null;
      }
    }
    return null;
  };

  /** History a joining client can render without duplicating the active turn. */
  const visibleHistory = (): SessionEvent[] =>
    turnRunning ? session.events.slice(0, turnSessionStart) : session.events;

  /**
   * Prompts that belong to the active turn. Steering messages already drained
   * are in the session log; anything still queued is appended after them.
   */
  const turnPrompts = (): string[] => {
    const prompts: string[] = [];
    for (const event of session.events.slice(turnSessionStart)) {
      if (event.type !== "user_message") continue;
      const message = event.message as { content?: unknown } | undefined;
      const text = contentPartsText(message?.content ?? event.content);
      if (text) prompts.push(text);
    }
    if (prompts.length === 0 && turnInput) prompts.push(turnInput);
    return [...prompts, ...steeringQueue];
  };

  const listSessions = (): SessionListing[] =>
    options.store?.listSessions(workspace) ?? [];

  const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const fail = (client: WebSocket, err: unknown): void => {
    sendTo(client, { type: "error", message: errorText(err) });
  };

  /** Expand `~`, resolve relative paths against the current workspace. */
  const expandPath = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) return resolve(workspace);
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) {
      return resolve(join(homedir(), trimmed.slice(2)));
    }
    return resolve(workspace, trimmed);
  };

  /** One directory level for the Ctrl+O workspace explorer. */
  const browseDirectory = (input?: string): DirectoryListing => {
    const target = input?.trim() ? expandPath(input) : resolve(workspace);
    const stat = statSync(target);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${target}`);
    const directories = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .slice(0, 500);
    const parent = dirname(target);
    return {
      path: target,
      parent: parent === target ? null : parent,
      directories,
    };
  };

  /** Flush a session's log and always release its ownership lock. */
  const retireSession = async (target: Session): Promise<void> => {
    try {
      await target.flush?.();
    } finally {
      target.releaseLock?.();
    }
  };

  /** Retire a session whose write failure was already surfaced by its turn. */
  const retireSessionQuietly = (target: Session): void => {
    void retireSession(target).catch(() => {
      // The turn already surfaced the write failure; never keep the lock.
    });
  };

  const renameSession = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) throw new Error("title cannot be empty");
    if (id === session.id) {
      session.appendEvent?.({ type: "session_renamed", title: trimmed });
      await session.flush?.();
    } else {
      if (!options.store) throw new Error("sessions are disabled");
      const target = options.store.resume(id);
      if (!target) throw new Error(`no session ${id}`);
      try {
        if (target.workspace !== workspace) {
          throw new Error("session belongs to another workspace");
        }
        target.appendEvent?.({ type: "session_renamed", title: trimmed });
        await target.flush?.();
      } finally {
        target.releaseLock?.();
      }
    }
    broadcast({ type: "sessions", sessions: listSessions() });
  };

  const deleteSession = async (id: string): Promise<void> => {
    if (!options.store) throw new Error("sessions are disabled");
    if (!options.store.listSessions(workspace).some((item) => item.id === id)) {
      throw new Error(`no session ${id}`);
    }
    sessionAttachments.delete(id);
    removeAttachmentDirectory(id);
    if (id === session.id) {
      // The user asked for deleting the current chat to start a fresh one.
      const previous = session;
      const next = newSession();
      session = next;
      steeringQueue.length = 0;
      broadcast({
        type: "session_changed",
        sessionId: session.id,
        history: historyOf(session),
        goal: goalOf(session),
      });
      await retireSession(previous);
      options.store.deleteSession(id);
    } else {
      options.store.deleteSession(id);
    }
    broadcast({ type: "sessions", sessions: listSessions() });
  };

  const switchWorkspace = async (path: string): Promise<void> => {
    const target = expandPath(path);
    const stat = statSync(target);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${target}`);
    const next = createSessionIn(target);
    const previous = session;
    sessionAttachments.delete(previous.id);
    removeAttachmentDirectory(previous.id);
    workspace = target;
    options.runtime.setWorkspace(target);
    options.approvals.resetTrust?.();
    if (options.agents && activeAgent) {
      const available = agentList();
      if (!available.some((agent) => agent.name === activeAgent)) {
        activeAgent = null;
        options.runtime.setPersona(undefined);
        broadcast({
          type: "agent_changed",
          agent: null,
          agents: available,
        });
      }
    }
    steeringQueue.length = 0;
    session = next;
    broadcast({
      type: "workspace_changed",
      workspace,
      sessionId: session.id,
      history: historyOf(session),
      goal: goalOf(session),
    });
    broadcast({ type: "sessions", sessions: listSessions() });
    await retireSession(previous);
  };

  const broadcastRuntimeState = (): void =>
    broadcast({
      type: "runtime_state",
      mode: currentMode,
      effort: currentEffort,
    });

  const setRuntimeMode = (mode: "plan" | "yolo"): void => {
    if (mode === currentMode) return;
    if (!options.setMode) throw new Error("mode switching is disabled");
    options.setMode(mode);
    currentMode = mode;
    broadcastRuntimeState();
  };

  const setRuntimeEffort = (effort: string): void => {
    const normalized = effort.trim().slice(0, 32);
    if (!normalized || normalized === currentEffort) return;
    if (!options.setEffort) throw new Error("effort switching is disabled");
    options.setEffort(normalized);
    currentEffort = normalized;
    broadcastRuntimeState();
  };

  const attachmentDir = (): string =>
    join(workspace, ".atom-lite", "attachments", session.id);

  const removeAttachmentDirectory = (sessionId: string): void => {
    try {
      rmSync(join(workspace, ".atom-lite", "attachments", sessionId), {
        recursive: true,
        force: true,
      });
    } catch {
      // best effort: a stale attachment directory is harmless
    }
  };

  const attachFile = (
    id: string | undefined,
    name: string,
    mime: string,
    data: string,
  ): {
    id?: string;
    name: string;
    path: string;
    size: number;
    mime: string;
  } => {
    const safe = basename(name)
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 100);
    if (!safe || safe === "." || safe === "..") {
      throw new Error("invalid attachment name");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error("attachment data is not valid base64");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
      throw new Error("attachment must be between 1 byte and 20 MB");
    }
    const directory = attachmentDir();
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${safe}`);
    writeFileSync(path, bytes);
    const paths = sessionAttachments.get(session.id) ?? [];
    if (paths.length >= 10) {
      unlinkSync(path);
      throw new Error("at most 10 attachments per message");
    }
    paths.push(path);
    sessionAttachments.set(session.id, paths);
    return { id, name: safe, path, size: bytes.length, mime };
  };

  const removeAttachment = (path: string): void => {
    const directory = resolve(attachmentDir());
    const resolved = resolve(path);
    if (!resolved.startsWith(directory + sep)) {
      throw new Error("attachment belongs to another session");
    }
    const paths = sessionAttachments.get(session.id) ?? [];
    const next = paths.filter((item) => item !== resolved);
    if (next.length > 0) sessionAttachments.set(session.id, next);
    else sessionAttachments.delete(session.id);
    try {
      unlinkSync(resolved);
    } catch {
      // already gone
    }
    broadcast({ type: "attachment_removed", path: resolved });
  };

  const refreshModels = async (): Promise<void> => {
    if (options.refreshModels) {
      const next = await options.refreshModels();
      if (next.length > 0) models = next;
    }
    broadcast({ type: "models", models });
  };

  const switchModel = async (
    provider: string,
    model: string,
  ): Promise<void> => {
    if (!options.switchModel) throw new Error("model switching is disabled");
    const result = await options.switchModel(provider, model);
    if ("error" in result) throw new Error(result.error);
    providerName = result.provider;
    currentModel = result.model;
    if (result.models && result.models.length > 0) models = result.models;
    broadcast({
      type: "model_changed",
      provider: providerName,
      model: currentModel,
      models,
    });
  };

  const agentList = (): WebAgent[] => {
    if (!options.agents) return [];
    try {
      return options.agents(workspace);
    } catch {
      return [];
    }
  };

  const switchAgent = async (name: string): Promise<void> => {
    if (turnRunning) {
      throw new Error("cannot switch agent while a turn is running");
    }
    if (!options.switchAgent) throw new Error("agent switching is disabled");
    const result = await options.switchAgent(name, workspace);
    if ("error" in result) throw new Error(result.error);
    activeAgent = result.agent;
    broadcast({
      type: "agent_changed",
      agent: activeAgent,
      agents: result.agents,
    });
  };

  const denyPendingApprovals = (): void => {
    for (const pending of pendingApprovals.values()) pending.resolve("deny");
    pendingApprovals.clear();
  };

  /**
   * The last client left with an approval pending. The request stays open for
   * a grace period so a dropped connection can reconnect and answer it; if
   * nobody comes back, it fails safe as a denial.
   */
  const scheduleApprovalFailSafe = (): void => {
    if (approvalTimer) return;
    const grace = Math.max(0, options.approvalGraceMs ?? 120_000);
    approvalTimer = setTimeout(() => {
      approvalTimer = undefined;
      denyPendingApprovals();
    }, grace);
    approvalTimer.unref?.();
  };

  /** Hand a still-pending prompt to the client that can answer it. */
  const sendPendingApprovals = (client: WebSocket): void => {
    if (controller !== client) return;
    for (const pending of pendingApprovals.values()) {
      sendTo(client, pending.message);
    }
  };

  const runTurn = async (initial: string): Promise<void> => {
    turnRunning = true;
    turnEvents = [];
    replayBytes = 0;
    replayTruncated = false;
    turnStartedAt = Date.now();
    turnOutputTokens = 0;
    turnModelMs = 0;
    turnSessionStart = session.events.length;
    const attachments = sessionAttachments.get(session.id) ?? [];
    sessionAttachments.delete(session.id);
    const prompt = attachments.length
      ? `${initial}\n\n[Attached local files]\n${attachments.map((path) => `- ${path}`).join("\n")}`
      : initial;
    turnInput = prompt;
    const controllerAbort = new AbortController();
    activeAbort = controllerAbort;
    broadcast({ type: "turn_start", turnId: ++turnCounter });
    let next: string | undefined = prompt;
    let stopped = false;
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
      if (
        controllerAbort.signal.aborted ||
        (err instanceof Error && err.message === "USER_CANCELLED")
      ) {
        // Escape is a normal outcome, not an error the browser should toast.
        // Providers may surface their own abort error (for example a fetch
        // AbortError), so the signal is the reliable marker.
        stopped = true;
      } else {
        broadcast({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      // No awaits between the final queue check and turn_end: a message
      // arriving after this point starts a new turn, never a stranded queue.
      turnRunning = false;
      activeAbort = undefined;
      broadcast({
        type: "turn_end",
        stopped,
        elapsedMs: turnStartedAt > 0 ? Date.now() - turnStartedAt : undefined,
        outputTokens: turnOutputTokens,
        modelMs: turnModelMs,
      });
      turnStartedAt = 0;
      turnOutputTokens = 0;
      turnModelMs = 0;
      turnEvents = [];
      replayBytes = 0;
      replayTruncated = false;
      turnSessionStart = 0;
      turnInput = "";
    }
  };

  const handleInput = (client: WebSocket, text: string): void => {
    if (closing) {
      sendTo(client, { type: "error", message: "server is shutting down" });
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    // Every tab sees the prompt, including viewer tabs that cannot send one.
    broadcast({ type: "user_input", text: trimmed });
    if (turnRunning) {
      const attachments = sessionAttachments.get(session.id) ?? [];
      sessionAttachments.delete(session.id);
      const queued = attachments.length
        ? `${trimmed}\n\n[Attached local files]\n${attachments.map((path) => `- ${path}`).join("\n")}`
        : trimmed;
      steeringQueue.push(queued);
      // Only the sender needs the pending row.
      sendTo(client, { type: "input_queued", text: trimmed });
      return;
    }
    turnPromise = runTurn(trimmed);
  };

  /**
   * Switch synchronously: a concurrent input after this call must start on
   * the new session, never on the outgoing one. The old log is flushed in the
   * background; every turn already flushed before turn_end.
   */
  const switchSession = (next: Session): void => {
    if (next.id === session.id) {
      // Re-opening the active session would drop the lock the server already
      // holds; ignore the no-op switch.
      next.releaseLock?.();
      return;
    }
    const previous = session;
    sessionAttachments.delete(previous.id);
    removeAttachmentDirectory(previous.id);
    session = next;
    steeringQueue.length = 0;
    broadcast({
      type: "session_changed",
      sessionId: session.id,
      history: historyOf(session),
      goal: goalOf(session),
    });
    broadcast({ type: "sessions", sessions: listSessions() });
    retireSessionQuietly(previous);
  };

  /**
   * Sessions are workspace-scoped: a browser in one workspace must never be
   * offered (or able to resume) another workspace's transcript.
   */
  const resumeSession = (
    id: string,
  ): { session: Session } | { error: string } => {
    if (!options.store) return { error: "sessions are disabled" };
    let next: Session | undefined;
    try {
      next = options.store.resume(id);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!next) return { error: `no session ${id}` };
    if (next.workspace !== workspace) {
      next.releaseLock?.();
      return { error: "session belongs to another workspace" };
    }
    return { session: next };
  };

  const createSessionIn = (path: string): Session =>
    options.store
      ? options.store.create(path, providerName)
      : new InMemorySession(randomUUID(), path, providerName);

  const newSession = (): Session => {
    // Trust-for-session is per conversation, matching the terminal.
    options.approvals.resetTrust?.();
    return createSessionIn(workspace);
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

  const settleQuestion = (id: string, outcome: QuestionOutcome): boolean => {
    const pending = pendingQuestions.get(id);
    if (!pending) return false;
    pendingQuestions.delete(id);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve(outcome);
    return true;
  };

  const cancelPendingQuestions = (message?: string): void => {
    for (const [id] of [...pendingQuestions]) {
      settleQuestion(id, {
        status: "cancelled",
        ...(message ? { message } : {}),
      });
      broadcast({ type: "question_resolved", id });
    }
  };

  /** Re-send a pending question to a newly controlling tab. */
  const sendPendingQuestions = (client: WebSocket): void => {
    if (controller !== client) return;
    for (const pending of pendingQuestions.values()) {
      if (pending.message.type === "question_request") {
        sendTo(client, pending.message);
      }
    }
  };

  const previousQuestionHandler = options.questions?.handler;
  const previousQuestionNonInteractive = options.questions?.nonInteractive;
  if (options.questions) {
    options.questions.nonInteractive = false;
    options.questions.handler = (request, signal) =>
      new Promise<QuestionOutcome>((resolve) => {
        const id = randomUUID();
        const message: ServerMessage = {
          type: "question_request",
          id,
          turnId: turnCounter,
          questions: request.questions,
        };
        const pending: PendingQuestion = {
          turnId: turnCounter,
          message,
          resolve,
          signal,
        };
        const onAbort = () => {
          if (!settleQuestion(id, { status: "cancelled" })) return;
          broadcast({ type: "question_resolved", id });
        };
        pending.onAbort = onAbort;
        pendingQuestions.set(id, pending);
        signal?.addEventListener("abort", onAbort, { once: true });

        if (controller) sendTo(controller, message);
        else {
          // No tab can answer. Cancel with a message so the model continues.
          settleQuestion(id, {
            status: "cancelled",
            message: "No browser is connected to answer questions.",
          });
        }
      });
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      if (!isAllowedRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden\n");
        return;
      }
      if (requestToken(req, url) !== token) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("missing or invalid token\n");
        return;
      }
      if (url.pathname === "/image") {
        const raw = url.searchParams.get("path") ?? "";
        let target = raw.trim();
        if (target === "~") target = homedir();
        else if (target.startsWith("~/"))
          target = join(homedir(), target.slice(2));
        const absolute = resolve(workspace, target);
        const type = MIME[extname(absolute).toLowerCase()] ?? "";
        if (!IMAGE_EXTENSIONS.has(extname(absolute).toLowerCase())) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found\n");
          return;
        }
        try {
          // Resolve symlinks before the containment check: a link inside the
          // workspace must not become a read primitive for files outside it.
          const root = realpathSync(workspace);
          const real = realpathSync(absolute);
          if (real !== root && !real.startsWith(root + sep)) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found\n");
            return;
          }
          const bytes = await readFile(real);
          res.writeHead(200, {
            "content-type": type,
            "content-length": bytes.length,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
          });
          res.end(bytes);
        } catch {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found\n");
        }
        return;
      }

      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const safeName =
        /^[A-Za-z0-9._-]+$/.test(name) ||
        /^vendor\/[A-Za-z0-9._-]+$/.test(name);
      if (!safeName) {
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
              .replaceAll(THEME_PLACEHOLDER, theme)
              .replace(/\b(src|href)="\/([^"?]+)"/g, `$1="/$2?token=${token}"`)
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

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxMessageBytes,
  });
  httpServer.on("upgrade", (req, socket, head) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (!isAllowedRequest(req) || requestToken(req, url) !== token) {
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
    if (closing) {
      sendTo(client, { type: "error", message: "server is shutting down" });
      return;
    }
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
      case "question_response": {
        if (!requireController(client)) return;
        const pending = pendingQuestions.get(message.id);
        if (!pending || pending.message.type !== "question_request") return;
        const answers = pending.message.questions.map((_, index) => {
          const raw = message.answers[index];
          if (!Array.isArray(raw)) return [];
          return raw
            .filter((item) => typeof item === "string")
            .map((item) => item.trim().slice(0, 4000))
            .filter(Boolean);
        });
        if (settleQuestion(message.id, { status: "answered", answers })) {
          broadcast({ type: "question_resolved", id: message.id });
        }
        return;
      }
      case "question_dismiss":
        if (!requireController(client)) return;
        if (settleQuestion(message.id, { status: "cancelled" })) {
          broadcast({ type: "question_resolved", id: message.id });
        }
        return;
      case "stop":
        if (!requireController(client)) return;
        if (!turnRunning || !activeAbort) return;
        broadcast({ type: "turn_stopping" });
        // A tool blocked on an approval would otherwise keep the turn alive
        // after the abort; deny it so the runtime can unwind.
        denyPendingApprovals();
        activeAbort.abort();
        return;
      case "list_sessions":
        sendTo(client, { type: "sessions", sessions: listSessions() });
        return;
      case "new_session":
        switchSessionIfIdle(client, () => ({ session: newSession() }));
        return;
      case "resume_session":
        switchSessionIfIdle(client, () => resumeSession(message.id));
        return;
      case "rename_session":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        void renameSession(message.id, message.title).catch((err) =>
          fail(client, err),
        );
        return;
      case "delete_session":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        void deleteSession(message.id).catch((err) => fail(client, err));
        return;
      case "switch_model":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        void switchModel(message.provider, message.model).catch((err) =>
          fail(client, err),
        );
        return;
      case "list_agents":
        sendTo(client, {
          type: "agents",
          agents: agentList(),
          active: activeAgent,
        });
        return;
      case "switch_agent":
        if (!requireController(client)) return;
        void switchAgent(message.name).catch((err) => fail(client, err));
        return;
      case "browse_directory":
        if (!requireController(client)) return;
        void (async () => {
          try {
            sendTo(client, {
              type: "directory",
              listing: browseDirectory(message.path),
            });
          } catch (err) {
            fail(client, err);
          }
        })();
        return;
      case "pick_workspace":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        if (pickingWorkspace) {
          sendTo(client, {
            type: "error",
            message: "A folder picker is already open.",
          });
          return;
        }
        pickingWorkspace = true;
        void (async () => {
          try {
            const picked = await (
              options.pickDirectory ?? pickNativeDirectory
            )();
            if (!picked) {
              sendTo(client, { type: "workspace_pick_cancelled" });
              return;
            }
            await switchWorkspace(picked);
          } catch (err) {
            fail(client, err);
          } finally {
            pickingWorkspace = false;
          }
        })();
        return;
      case "switch_workspace":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        void switchWorkspace(message.path).catch((err) => fail(client, err));
        return;
      case "set_effort":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        try {
          setRuntimeEffort(message.effort);
        } catch (err) {
          fail(client, err);
        }
        return;
      case "set_mode":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        try {
          setRuntimeMode(message.mode);
        } catch (err) {
          fail(client, err);
        }
        return;
      case "set_goal":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        options.runtime.setGoal(message.statement, session);
        return;
      case "set_goal_criteria":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        options.runtime.setGoalCriteria(message.criteria, session);
        return;
      case "set_goal_constraints":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        options.runtime.setGoalConstraints(message.constraints, session);
        return;
      case "goal_action":
        if (!requireController(client)) return;
        if (rejectWhileTurnRunning(client)) return;
        if (message.action === "complete") {
          const result = options.runtime.completeGoal(undefined, session);
          if (!result.ok) {
            sendTo(client, {
              type: "error",
              message:
                "goal not complete: unmet criteria: " + result.unmet.join("; "),
            });
          }
        } else if (message.action === "pause") {
          options.runtime.pauseGoal(session);
        } else if (message.action === "resume") {
          options.runtime.resumeGoal(session);
        } else {
          options.runtime.clearGoal(session);
        }
        return;
      case "refresh_models":
        if (!requireController(client)) return;
        void refreshModels().catch((err) => fail(client, err));
        return;
      case "attach_file":
        if (!requireController(client)) return;
        try {
          const attachment = attachFile(
            message.id,
            message.name,
            message.mime,
            message.data,
          );
          sendTo(client, { type: "attachment", ...attachment });
        } catch (err) {
          fail(client, err);
        }
        return;
      case "remove_attachment":
        if (!requireController(client)) return;
        try {
          removeAttachment(message.path);
        } catch (err) {
          fail(client, err);
        }
        return;
      case "list_skills":
        try {
          sendTo(client, {
            type: "skills",
            skills: options.skills?.(workspace) ?? [],
          });
        } catch (err) {
          fail(client, err);
        }
        return;
      case "list_mcp":
        try {
          sendTo(client, {
            type: "mcp",
            servers: options.mcpStatus?.() ?? [],
          });
        } catch (err) {
          fail(client, err);
        }
        return;
      case "set_mcp_enabled":
        if (!requireController(client)) return;
        if (turnRunning) {
          sendTo(client, {
            type: "error",
            message: "cannot change MCP servers while a turn is running",
          });
          return;
        }
        void (async () => {
          try {
            if (!options.setMcpEnabled) {
              throw new Error("MCP switching is disabled");
            }
            await options.setMcpEnabled(message.name, message.enabled);
            broadcast({
              type: "mcp",
              servers: options.mcpStatus?.() ?? [],
            });
          } catch (err) {
            fail(client, err);
          }
        })();
        return;
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    if (closing || clients.size >= maxClients) {
      ws.close(1013, "server is not accepting connections");
      return;
    }
    // A malformed or oversized frame is a socket-level error; it must not
    // become an uncaught exception that takes the server down.
    ws.on("error", () => {});
    clients.add(ws);
    if (!controller) controller = ws;
    sendTo(ws, {
      type: "hello",
      sessionId: session.id,
      provider: providerName,
      model: currentModel,
      workspace,
      models,
      mode: currentMode,
      effort: currentEffort,
      agent: activeAgent,
      agents: agentList(),
      readOnly: controller !== ws,
      nativePicker: !isAndroid(),
      history: visibleHistory(),
      context: options.runtime.getContextUsage(),
      goal: goalOf(session),
    });
    if (turnRunning) {
      // Rebuild the in-flight turn, which is not in the session history until
      // it completes. Sent immediately after hello, before any live event.
      sendTo(ws, {
        type: "replay",
        turnId: turnCounter,
        prompts: turnPrompts(),
        events: turnEvents,
        truncated: replayTruncated,
      });
    }
    // A prompt that was pending when the previous client dropped is handed
    // to whoever controls the session now.
    sendPendingApprovals(ws);
    sendPendingQuestions(ws);

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
          sendPendingApprovals(controller);
          sendPendingQuestions(controller);
        }
      }
      if (clients.size === 0) {
        scheduleApprovalFailSafe();
        cancelPendingQuestions("No browser is connected to answer questions.");
      }
    });
  });

  const port = await listenWithFallback(httpServer, host, options.port ?? 0);
  const url = `http://${localHost}:${port}/?token=${token}`;
  const wsUrl = `ws://${localHost}:${port}/?token=${token}`;

  if (options.openBrowser) {
    void openBrowser(url);
  }

  return {
    url,
    wsUrl,
    port,
    token,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        const httpClosed = new Promise<void>((resolve) =>
          httpServer.close(() => resolve()),
        );

        // Cancel the turn before closing sockets so its final writes flush and
        // the session log stays resumable. A turn that ignores the signal is
        // bounded by a short shutdown timeout rather than blocking exit.
        activeAbort?.abort();
        // A tool may be blocked on an approval or question; settle both so
        // the turn can unwind instead of waiting for the shutdown timeout.
        denyPendingApprovals();
        cancelPendingQuestions("The server is shutting down.");
        if (turnPromise) {
          await Promise.race([
            turnPromise.catch(() => {}),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 5_000);
              timer.unref?.();
            }),
          ]);
        }

        const closingClients = [...clients];
        for (const client of closingClients) {
          try {
            client.close();
          } catch {
            // best effort
          }
        }
        clients.clear();
        const forceClose = setTimeout(() => {
          for (const client of closingClients) {
            try {
              client.terminate();
            } catch {
              // already gone
            }
          }
        }, 250);
        forceClose.unref?.();

        if (approvalTimer) {
          clearTimeout(approvalTimer);
          approvalTimer = undefined;
        }
        denyPendingApprovals();
        if (options.questions) {
          options.questions.handler = previousQuestionHandler;
          options.questions.nonInteractive =
            previousQuestionNonInteractive ?? true;
        }
        options.runtime.setEventSink(undefined);
        wss.close();
        await httpClosed;
        await session.flush?.();
        session.releaseLock?.();
      })();
      return closePromise;
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
