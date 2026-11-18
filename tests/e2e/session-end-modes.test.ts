// E2E: session_end must fire in every terminal mode, not just the interactive
// exit path. A fixture extension records the event to a per-mode marker file.
// The provider stub lives in the parent process (async child spawn).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const execFileAsync = promisify(execFile);
let server: Server;
server = createServer(async (req, res) => {
  for await (const _ of req) {
    // drain
  }
  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
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

const root = mkdtempSync(join(tmpdir(), "atom-e2e-session-end-"));
let child: ChildProcess | undefined;
after(() => {
  if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
  try {
    server.close();
  } catch {
    // best effort
  }
  rmSync(root, { recursive: true, force: true });
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
  join(extensionsDir, "session-end.js"),
  [
    'import { writeFileSync } from "node:fs";',
    "export default (api) => {",
    "  api.on('session_end', (event) => {",
    "    writeFileSync(process.env.SESSION_END_MARKER, JSON.stringify({ type: event.type }));",
    "  });",
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

function envFor(marker: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: "1",
    SESSION_END_MARKER: marker,
  };
}

function assertMarker(marker: string): void {
  assert.ok(existsSync(marker), `session_end marker missing: ${marker}`);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
    type: "session_end",
  });
}

test("session_end fires on the one-shot path", async () => {
  const marker = join(root, "one-shot.json");
  await execFileAsync(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), "say ok"],
    { cwd: project, env: envFor(marker), encoding: "utf8", timeout: 30000 },
  );
  assertMarker(marker);
});

test("session_end fires on the JSON path", async () => {
  const marker = join(root, "json.json");
  await execFileAsync(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), "--json", "say ok"],
    { cwd: project, env: envFor(marker), encoding: "utf8", timeout: 30000 },
  );
  assertMarker(marker);
});

test("session_end fires on serve shutdown", async () => {
  const marker = join(root, "serve.json");
  child = spawn(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), "--serve", "0"],
    {
      cwd: project,
      env: envFor(marker),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve did not start:\n${output}`)),
      20000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/web UI at http:\/\/\S+/.test(output)) {
        clearTimeout(timer);
        child?.stdout?.off("data", onData);
        resolve();
      }
    };
    child?.stdout?.on("data", onData);
    child?.once("error", reject);
  });
  child.kill("SIGINT");
  await new Promise<void>((resolve) => child!.once("close", () => resolve()));
  assertMarker(marker);
});
