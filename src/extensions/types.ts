export type AtomEvent =
  | "extension_load"
  | "extension_activate"
  | "extension_unload"
  | "extension_error"
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "message"
  | "context_build"
  | "config_change";

export interface ExtensionTool {
  name: string;
  label: string;
  description: string;
  parameters?: Record<string, unknown>;
  exposure?: "direct" | "model-only" | "hidden" | "codemode" | "deferred";
  annotations?: Record<string, unknown>;
  execute: (...args: any[]) => Promise<unknown>;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  argumentHint?: string;
  category?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  run?: (args: string, ctx: ExtensionContext) => void | Promise<void>;
  handler?: (args: string, ctx: any) => void | Promise<void>;
}

export interface ExtensionWidget {
  id: string;
  location: "aboveInput" | "belowInput" | "footer";
  render: (width: number) => string[];
}

export interface ExtensionContext {
  workspace: string;
  trusted: boolean;
  log: (message: string) => void;
  sessionManager?: any;
}

export interface ExtensionProvider {
  name: string;
  config: Record<string, unknown>;
}

export interface ExtensionModel {
  provider: string;
  id: string;
  metadata?: Record<string, unknown>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type ExtensionEventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

export interface ExtensionStatus {
  id: string;
  source: string;
  entryPath: string;
  status: "loaded" | "error" | "skipped";
  error?: string;
}
