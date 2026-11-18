// E2E: --no-tools must suppress extension tools all the way to the provider
// request. A cached startup tool list would leak the tool registered by the
// fixture extension, so this pins the app.ts wiring of the single-source
// resolver. The stub provider lives in the parent process (async child spawn).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const execFileAsync = promisify(execFile);

let server: Server;
let lastTools: unknown;

server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      lastTools = body.tools;
    } catch {
      lastTools = undefined;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
server.unref();
const port = (server.address() as { port: number }).port;

const root = mkdtempSync(join(tmpdir(), "atom-e2e-notools-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  server.close();
});

const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
const userConfigDir = join(configHome, "atom-lite");
const extensionsDir = join(userConfigDir, "extensions");
for (const dir of [
  home,
  configHome,
  agentDir,
  project,
  userConfigDir,
  extensionsDir,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(
  join(extensionsDir, "visible.js"),
  [
    "export default (api) => {",
    "  api.registerTool({ name: 'ext_marker_tool', label: 'm', description: 'marker', execute: async () => 'marker' });",
    "};",
    "",
  ].join("\n"),
);
writeFileSync(
  join(userConfigDir, "config.json"),
  JSON.stringify({
    defaultProvider: "stub",
    providers: {
      stub: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "stub-model",
        apiKey: "stub-key",
      },
    },
  }),
);

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        PI_CODING_AGENT_DIR: agentDir,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 30000,
      killSignal: "SIGKILL",
    },
  );
  return stdout;
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tool: any) => tool?.function?.name ?? tool?.name)
    .filter((name: unknown): name is string => typeof name === "string");
}

test("--no-tools keeps extension tools out of the provider request", async () => {
  await runCli(["--json", "--no-tools", "say ok"]);
  assert.ok(
    !toolNames(lastTools).includes("ext_marker_tool"),
    `extension tool leaked with --no-tools: ${JSON.stringify(lastTools)}`,
  );
  assert.ok(
    lastTools === undefined ||
      (Array.isArray(lastTools) && lastTools.length === 0),
    `--no-tools sends no tool definitions, got ${JSON.stringify(lastTools)}`,
  );
});

test("extension tools reach the provider request without --no-tools", async () => {
  await runCli(["--json", "say ok"]);
  assert.ok(
    toolNames(lastTools).includes("ext_marker_tool"),
    `fixture tool missing without --no-tools: ${JSON.stringify(lastTools)}`,
  );
});
