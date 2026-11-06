import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { LspServerConfig, LspServerInfo } from "./types.js";

function commandExists(command: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where" : "command",
      process.platform === "win32" ? [command] : ["-v", command],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

function makePreset(
  id: string,
  command: string,
  args: string[],
  extensions: string[],
  rootMarkers: string[],
): LspServerInfo | null {
  if (!commandExists(command)) return null;
  return { id, command, args, extensions, rootMarkers, initialization: {} };
}

export function builtinServers(): LspServerInfo[] {
  const out: LspServerInfo[] = [];
  const ts = makePreset(
    "typescript",
    "typescript-language-server",
    ["--stdio"],
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    ["package.json", "tsconfig.json", "jsconfig.json"],
  );
  if (ts) out.push(ts);

  const py = makePreset(
    "pyright",
    "pyright-langserver",
    ["--stdio"],
    [".py", ".pyi"],
    ["pyproject.toml", "setup.py", "requirements.txt"],
  );
  if (py) out.push(py);

  const go = makePreset("gopls", "gopls", ["serve"], [".go"], ["go.mod"]);
  if (go) out.push(go);

  const rust = makePreset(
    "rust-analyzer",
    "rust-analyzer",
    [],
    [".rs"],
    ["Cargo.toml"],
  );
  if (rust) out.push(rust);

  return out;
}

export function configToServer(
  id: string,
  cfg: LspServerConfig,
): LspServerInfo {
  return {
    id,
    command: cfg.command,
    args: cfg.args ?? [],
    extensions: cfg.extensions ?? [],
    rootMarkers: cfg.rootMarkers ?? [],
    initialization: cfg.initialization,
  };
}

export function resolveRoot(
  server: LspServerInfo,
  filePath: string,
  workspace: string,
): string | null {
  let dir = path.dirname(filePath);
  const workspaceResolved = path.resolve(workspace);
  while (true) {
    for (const marker of server.rootMarkers) {
      if (existsSync(path.join(dir, marker))) return dir;
    }
    if (dir === workspaceResolved) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!dir.startsWith(workspaceResolved)) break;
    dir = parent;
  }
  if (path.resolve(filePath).startsWith(workspaceResolved))
    return workspaceResolved;
  return null;
}

export function matchesExtension(
  server: LspServerInfo,
  filePath: string,
): boolean {
  return server.extensions.includes(path.extname(filePath).toLowerCase());
}
