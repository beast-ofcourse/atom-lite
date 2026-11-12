// E2E: spawn the real CLI (dist/cli/main.js) against a stub OpenAI-compatible
// server and verify the full feature flow:
//   user task -> provider stream -> tool call -> read tool -> session log ->
//   final answer -> --json output.
// No external network: the provider is a local http server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const execFileAsync = promisify(execFile);

let server: Server;
let port = 0;
let requests = 0;

const SSE_TOOL_CALL = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_read_1",
              function: { name: "read", arguments: '{"path":"note' },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }],
        },
      },
    ],
  },
];

const SSE_FINAL = [
  {
    choices: [{ delta: { content: "The note says: E2E-TOKEN-OK" } }],
  },
];

server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    requests++;
    const payload = requests === 1 ? SSE_TOOL_CALL : SSE_FINAL;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of payload) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
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
port = (server.address() as { port: number }).port;

const root = mkdtempSync(join(tmpdir(), "atom-e2e-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
for (const dir of [home, configHome, agentDir, project]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(project, "note.txt"), "The note says: E2E-TOKEN-OK\n");
const userConfigDir = join(configHome, "atom-lite");
mkdirSync(userConfigDir, { recursive: true });
writeFileSync(
  join(userConfigDir, "config.json"),
  JSON.stringify({
    defaultProvider: "stub",
    providers: {
      stub: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "e2e-model",
        apiKey: "e2e-key",
      },
    },
  }),
);

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
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
    return { stdout, stderr };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `CLI failed: ${e.message}\nstdout: ${e.stdout ?? ""}\nstderr: ${e.stderr ?? ""}`,
    );
  }
}

test("one-shot task drives a read tool call end to end", async () => {
  const { stdout } = await runCli([
    "--json",
    "read note.txt and tell me what it says",
  ]);
  const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  assert.ok(parsed.sessionId, "result includes the session id");
  assert.match(parsed.result, /E2E-TOKEN-OK/);
  assert.ok(requests >= 2, "provider was called for the tool round-trip");
});

test("the session log records the executed tool and the user task", async () => {
  const sessionsDir = join(userConfigDir, "sessions");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length > 0, "a session file was written");
  const log = files
    .map((f) => readFileSync(join(sessionsDir, f), "utf8"))
    .join("\n");
  assert.match(log, /"user_message"/);
  assert.match(log, /"tool_result"/);
  // The read tool numbered the file's lines.
  assert.match(log, /1: The note says: E2E-TOKEN-OK/);
  assert.match(log, /"assistant_message"/);
});
