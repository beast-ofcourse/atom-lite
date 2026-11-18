export type AtomEvent =
  | "extension_load"
  | "extension_activate"
  | "extension_unload"
  | "extension_error"
  | "session_start"
  | "session_end"
  | "session_shutdown"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "message_start"
  | "message_end"
  | "context_build"
  | "config_change"
  | "before_provider_request"
  | "after_provider_response"
  | "agent_before_settle"
  | "agent_settled"
  | "tool_execution_start"
  | "tool_execution_end"
  | "tool_execution_update";

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

export interface ExtensionUIContext {
  select(
    title: string,
    options: string[],
    opts?: any,
  ): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: any): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: any,
  ): Promise<string | undefined>;
  editor(
    title: string,
    prefill?: string,
    opts?: any,
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: {
    frames?: string[];
    intervalMs?: number;
  }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(
    key: string,
    content: string[] | ((tui: any, theme: any) => any) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setFooter(
    factory: ((tui: any, theme: any, footerData: any) => any) | undefined,
  ): void;
  setHeader(factory: ((tui: any, theme: any) => any) | undefined): void;
  setTitle(title: string): void;
  custom<T>(factory: any, options?: any): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  getTheme(name: string): any;
  setTheme(theme: string | any): { success: boolean; error?: string };
}

export interface ExtensionContext {
  workspace: string;
  trusted: boolean;
  hasUI: boolean;
  ui: ExtensionUIContext;
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
  /** Signal that ended the child (for example `SIGTERM` on abort/timeout). */
  signal?: string | null;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Environment overrides; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Cancels the child when aborted. */
  signal?: AbortSignal;
  /** Maximum captured bytes per stream; defaults to 10 MiB. */
  maxBuffer?: number;
  /** Receives live stdout/stderr chunks from the child. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
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
