import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.js";
import { builtinServers, configToServer, matchesExtension, resolveRoot } from "./server.js";
import { LspClient } from "./client.js";
import type { LspClientHandle, LspServerInfo } from "./types.js";

let enabled = false;
const servers: LspServerInfo[] = [];
const clients = new Map<string, LspClient>();
const broken = new Set<string>();
const inFlight = new Map<string, Promise<LspClient | undefined>>();

export function initLsp(config: Config, workspace: string): void {
  enabled = Boolean(config.lsp?.enabled);
  servers.length = 0;
  if (!enabled) return;
  for (const server of builtinServers()) {
    if (!(config.lsp?.servers?.[server.id]?.disabled)) servers.push(server);
  }
  for (const [id, cfg] of Object.entries(config.lsp?.servers ?? {})) {
    if (cfg.disabled) continue;
    const existing = servers.findIndex((s) => s.id === id);
    const converted = configToServer(id, cfg);
    if (existing >= 0) servers[existing] = converted;
    else servers.push(converted);
  }
  void workspace;
}

export function lspEnabled(): boolean {
  return enabled;
}

function clientKey(serverId: string, root: string): string {
  return `${serverId}:${root}`;
}

async function getClient(filePath: string): Promise<LspClient | undefined> {
  if (!enabled) return undefined;
  const resolvedPath = path.resolve(filePath);
  for (const server of servers) {
    if (!matchesExtension(server, resolvedPath)) continue;
    const root = resolveRoot(server, resolvedPath, process.cwd());
    if (!root) continue;
    const key = clientKey(server.id, root);
    if (broken.has(key)) continue;
    const existing = clients.get(key);
    if (existing) return existing;
    const running = inFlight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const client = new LspClient(server, root);
        await client.touchFile(resolvedPath).catch(() => {});
        clients.set(key, client);
        return client;
      } catch {
        broken.add(key);
        return undefined;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);
    return task;
  }
  return undefined;
}

export async function touchFile(filePath: string): Promise<void> {
  if (!enabled) return;
  await getClient(filePath);
}

export async function getDiagnostics(filePath?: string): Promise<Map<string, any[]>> {
  if (!enabled) return new Map();
  if (filePath) {
    const client = await getClient(filePath);
    if (!client) return new Map();
    await client.touchFile(filePath);
    await client.waitForDiagnostics(filePath, 300);
    return client.diagnostics(filePath);
  }
  const out = new Map<string, any[]>();
  for (const client of clients.values()) {
    for (const [file, diags] of client.diagnostics()) {
      out.set(file, diags);
    }
  }
  return out;
}

export async function definition(filePath: string, line: number, character: number): Promise<unknown> {
  const client = await getClient(filePath);
  if (!client) return null;
  await client.touchFile(filePath);
  return client.definition(filePath, line, character);
}

export async function references(filePath: string, line: number, character: number): Promise<unknown> {
  const client = await getClient(filePath);
  if (!client) return null;
  await client.touchFile(filePath);
  return client.references(filePath, line, character);
}

export async function documentSymbols(filePath: string): Promise<unknown> {
  const client = await getClient(filePath);
  if (!client) return null;
  await client.touchFile(filePath);
  return client.documentSymbols(filePath);
}

export async function workspaceSymbols(query: string): Promise<unknown> {
  const first = clients.values().next().value as LspClient | undefined;
  if (!first) return null;
  return first.workspaceSymbols(query);
}

export async function shutdownLsp(): Promise<void> {
  for (const client of clients.values()) {
    await client.shutdown().catch(() => {});
  }
  clients.clear();
}