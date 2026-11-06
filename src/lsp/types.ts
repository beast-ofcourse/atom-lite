export interface LspDiagnostic {
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensions?: string[];
  rootMarkers?: string[];
  initialization?: Record<string, unknown>;
  disabled?: boolean;
}

export interface LspServerInfo {
  id: string;
  extensions: string[];
  rootMarkers: string[];
  command: string;
  args: string[];
  initialization?: Record<string, unknown>;
}

export interface LspLocation {
  uri?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspClientHandle {
  touchFile(filePath: string): Promise<void>;
  waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<void>;
  diagnostics(filePath?: string): Map<string, LspDiagnostic[]>;
  definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown>;
  references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown>;
  documentSymbols(filePath: string): Promise<unknown>;
  workspaceSymbols(query: string): Promise<unknown>;
  shutdown(): Promise<void>;
}
