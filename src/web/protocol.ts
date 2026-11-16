import type { AgentEvent } from "../agent/types.js";
import type { SessionEvent, SessionSummary } from "../sessions/events.js";

/**
 * The JSON protocol between the browser and `atom-lite --serve`. Kept in one
 * place so the server and its tests share the same vocabulary; the browser
 * client (`web/app.js`) mirrors it in the comment at the top of the file.
 */

/** One selectable provider/model pair for the web model picker. */
export interface WebModel {
  provider: string;
  model: string;
  /** Human label such as a provider name, when the server has one. */
  label?: string;
}

/** One directory level returned by the workspace explorer. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
}

/** One skill exposed by the runtime's skill registry. */
export interface WebSkill {
  name: string;
  description: string;
  scope?: "global" | "project";
}

/** One MCP server as reported by the live manager. */
export interface WebMcpServer {
  name: string;
  state: string;
  enabled: boolean;
  requiresApproval: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
}

export type ClientMessage =
  | { type: "input"; text: string }
  | {
      type: "approval";
      id: string;
      /** Turn the answer belongs to; rejected when it does not match. */
      turnId?: number;
      decision: "approve" | "deny" | "trust-session";
    }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "resume_session"; id: string }
  | { type: "rename_session"; id: string; title: string }
  | { type: "delete_session"; id: string }
  | { type: "switch_model"; provider: string; model: string }
  | { type: "browse_directory"; path?: string }
  | { type: "switch_workspace"; path: string }
  | { type: "set_effort"; effort: string }
  | { type: "set_mode"; mode: "plan" | "yolo" }
  | { type: "refresh_models" }
  | {
      type: "attach_file";
      id?: string;
      name: string;
      mime: string;
      data: string;
    }
  | { type: "remove_attachment"; path: string }
  | { type: "list_skills" }
  | { type: "list_mcp" };

export type SessionListing = Pick<
  SessionSummary,
  "id" | "title" | "updatedAt" | "messageCount"
>;

export interface SessionState {
  sessionId: string;
  history: SessionEvent[];
}

export type ServerMessage =
  | {
      type: "hello";
      sessionId: string;
      provider: string;
      model: string;
      workspace: string;
      models: WebModel[];
      mode: "plan" | "yolo";
      effort: string;
      readOnly: boolean;
      history: SessionEvent[];
    }
  | { type: "event"; event: AgentEvent }
  | {
      type: "replay";
      turnId: number;
      prompts: string[];
      events: AgentEvent[];
      /** True when the active turn exceeded the server's replay budget. */
      truncated: boolean;
    }
  | { type: "user_input"; text: string }
  | { type: "turn_start"; turnId: number }
  | { type: "turn_end" }
  | { type: "input_queued"; text: string }
  | {
      type: "approval_request";
      id: string;
      turnId: number;
      request: {
        command: string;
        cwd: string;
        timeoutMs: number;
        sandboxed: boolean;
        tool?: string;
      };
    }
  | { type: "sessions"; sessions: SessionListing[] }
  | ({ type: "session_changed" } & SessionState)
  | ({ type: "workspace_changed"; workspace: string } & SessionState)
  | {
      type: "model_changed";
      provider: string;
      model: string;
      models: WebModel[];
    }
  | { type: "runtime_state"; mode: "plan" | "yolo"; effort: string }
  | { type: "models"; models: WebModel[] }
  | {
      type: "attachment";
      id?: string;
      name: string;
      path: string;
      size: number;
      mime: string;
    }
  | { type: "attachment_removed"; path: string }
  | { type: "skills"; skills: WebSkill[] }
  | { type: "mcp"; servers: WebMcpServer[] }
  | { type: "directory"; listing: DirectoryListing }
  | { type: "control"; readOnly: boolean }
  | { type: "error"; message: string };

export type ClientParseResult = { message: ClientMessage } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse one WebSocket text frame into a known message, or an error string. */
export function parseClientMessage(raw: string): ClientParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "malformed message" };
  }
  if (!isRecord(value)) return { error: "malformed message" };
  switch (value.type) {
    case "input":
      if (typeof value.text !== "string") {
        return { error: "input text must be a string" };
      }
      return { message: { type: "input", text: value.text } };
    case "approval": {
      const decision = value.decision;
      if (
        decision !== "approve" &&
        decision !== "deny" &&
        decision !== "trust-session"
      ) {
        return { error: "invalid approval decision" };
      }
      if (typeof value.id !== "string" || !value.id) {
        return { error: "approval id must be a string" };
      }
      return {
        message: {
          type: "approval",
          id: value.id,
          turnId: typeof value.turnId === "number" ? value.turnId : undefined,
          decision,
        },
      };
    }
    case "list_sessions":
      return { message: { type: "list_sessions" } };
    case "new_session":
      return { message: { type: "new_session" } };
    case "resume_session":
      if (typeof value.id !== "string" || !value.id) {
        return { error: "resume_session id must be a string" };
      }
      return { message: { type: "resume_session", id: value.id } };
    case "rename_session":
      if (typeof value.id !== "string" || !value.id) {
        return { error: "rename_session id must be a string" };
      }
      if (typeof value.title !== "string" || !value.title.trim()) {
        return { error: "rename_session title must be a non-empty string" };
      }
      return {
        message: { type: "rename_session", id: value.id, title: value.title },
      };
    case "delete_session":
      if (typeof value.id !== "string" || !value.id) {
        return { error: "delete_session id must be a string" };
      }
      return { message: { type: "delete_session", id: value.id } };
    case "switch_model":
      if (
        typeof value.provider !== "string" ||
        !value.provider.trim() ||
        typeof value.model !== "string" ||
        !value.model.trim()
      ) {
        return { error: "switch_model needs a provider and model" };
      }
      return {
        message: {
          type: "switch_model",
          provider: value.provider,
          model: value.model,
        },
      };
    case "browse_directory":
      if (value.path !== undefined && typeof value.path !== "string") {
        return { error: "browse_directory path must be a string" };
      }
      return {
        message: {
          type: "browse_directory",
          path: typeof value.path === "string" ? value.path : undefined,
        },
      };
    case "switch_workspace":
      if (typeof value.path !== "string" || !value.path.trim()) {
        return { error: "switch_workspace path must be a non-empty string" };
      }
      return { message: { type: "switch_workspace", path: value.path } };
    case "set_effort":
      if (typeof value.effort !== "string" || !value.effort.trim()) {
        return { error: "set_effort needs a level" };
      }
      return { message: { type: "set_effort", effort: value.effort } };
    case "set_mode":
      if (value.mode !== "plan" && value.mode !== "yolo") {
        return { error: "set_mode must be plan or yolo" };
      }
      return { message: { type: "set_mode", mode: value.mode } };
    case "refresh_models":
      return { message: { type: "refresh_models" } };
    case "attach_file":
      if (
        typeof value.name !== "string" ||
        !value.name.trim() ||
        typeof value.data !== "string" ||
        !value.data
      ) {
        return { error: "attach_file needs a name and file data" };
      }
      return {
        message: {
          type: "attach_file",
          id: typeof value.id === "string" ? value.id : undefined,
          name: value.name,
          mime:
            typeof value.mime === "string"
              ? value.mime
              : "application/octet-stream",
          data: value.data,
        },
      };
    case "remove_attachment":
      if (typeof value.path !== "string" || !value.path) {
        return { error: "remove_attachment needs a path" };
      }
      return { message: { type: "remove_attachment", path: value.path } };
    case "list_skills":
      return { message: { type: "list_skills" } };
    case "list_mcp":
      return { message: { type: "list_mcp" } };
    default:
      return { error: "unknown message type" };
  }
}
