// E2E: the shipped binary serves the web surface. A real WebSocket client
// runs a turn that hits the read tool outside the workspace, answers the
// browser approval, and gets the tool result and final answer back.
// No external network: the provider is a local stub OpenAI-compatible server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

const root = mkdtempSync(join(tmpdir(), "atom-e2e-web-"));
const home = join(root, "home");
const configHome = join(root, "config");
const agentDir = join(root, "agent");
const project = join(root, "project");
for (const dir of [home, configHome, agentDir, project]) {
  mkdirSync(dir, { recursive: true });
}
const outsidePath = join(root, "outside.txt");
writeFileSync(outsidePath, "E2E-WEB-OUTSIDE\n");

let requests = 0;
const stub: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests === 1) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read_1",
                    function: {
                      name: "read",
                      arguments: JSON.stringify({ path: outsidePath }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "The outside file says E2E-WEB-OK" } }],
        })}\n\n`,
      );
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
await new Promise<void>((resolve) =>
  stub.listen(0, "127.0.0.1", () => resolve()),
);
stub.unref();
const stubPort = (stub.address() as { port: number }).port;

const userConfigDir = join(configHome, "atom-lite");
mkdirSync(userConfigDir, { recursive: true });
writeFileSync(
  join(userConfigDir, "config.json"),
  JSON.stringify({
    defaultProvider: "stub",
    providers: {
      stub: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: "e2e-model",
        apiKey: "e2e-key",
      },
    },
  }),
);

let child: ChildProcess | undefined;
after(() => {
  try {
    stub.close();
  } catch {
    // best effort
  }
  if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

/** A WebSocket client that buffers messages and waits for types. */
class Client {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  private waiters: Array<{
    matches: (m: any) => boolean;
    resolve: (m: any) => void;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.matches(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await once(this.ws, "open");
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(type: string, timeoutMs = 15000): Promise<any> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return this.waitForMatching((m) => m.type === type, timeoutMs);
  }

  waitForMatching(
    matches: (message: any) => boolean,
    timeoutMs = 15000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a matching message")),
        timeoutMs,
      );
      this.waiters.push({
        matches,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

function startServer(): Promise<string> {
  child = spawn(
    process.execPath,
    [join(process.cwd(), "dist", "cli", "main.js"), "--serve", "0"],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        PI_CODING_AGENT_DIR: agentDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`web server did not start:\n${output}`)),
      20000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/web UI at (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child?.stdout?.on("data", onData);
    child?.stderr?.on("data", onData);
    child?.on("exit", (code) => {
      if (!/web UI at/.test(output)) {
        clearTimeout(timer);
        reject(new Error(`server exited (${code}):\n${output}`));
      }
    });
  });
}

test("the real binary serves a turn with a tool approval over the web protocol", async () => {
  const url = await startServer();
  const wsUrl = url.replace(/^http:/, "ws:");
  const client = new Client(wsUrl);
  await client.open();

  const hello = await client.waitFor("hello");
  assert.ok(hello.sessionId, "the server reports its session");
  assert.equal(hello.readOnly, false);

  // These callbacks run inside the real CLI serve branch, where TUI-only
  // state is not initialized.
  client.send({ type: "list_skills" });
  const skills = await client.waitFor("skills");
  assert.ok(Array.isArray(skills.skills), "skills come from the real registry");

  client.send({ type: "refresh_models" });
  const models = await client.waitFor("models");
  assert.ok(
    models.models.some(
      (item: any) =>
        item.provider === hello.provider && item.model === hello.model,
    ),
    "the live catalog contains the configured model",
  );

  client.send({
    type: "switch_model",
    provider: hello.provider,
    model: hello.model,
  });
  const switched = await client.waitFor("model_changed");
  assert.equal(switched.provider, hello.provider);
  assert.equal(switched.model, hello.model);
  assert.ok(
    !client.messages.some(
      (message) =>
        message.type === "error" &&
        /before initialization/.test(message.message),
    ),
    "the real serve callbacks do not touch TUI-only state",
  );

  client.send({ type: "input", text: "read the outside file" });
  const approval = await client.waitFor("approval_request");
  assert.match(approval.request.command, /read /);
  assert.equal(approval.request.tool, "read");
  assert.ok(
    !client.messages.some((m) => m.type === "turn_end"),
    "the turn waits for the approval",
  );

  client.send({
    type: "approval",
    id: approval.id,
    turnId: approval.turnId,
    decision: "approve",
  });
  await client.waitFor("turn_end");

  const toolCall = client.messages.find(
    (m) => m.type === "event" && m.event.type === "tool_call",
  );
  assert.equal(toolCall.event.name, "read");
  assert.equal(toolCall.event.args.path, outsidePath);

  const toolResult = client.messages.find(
    (m) => m.type === "event" && m.event.type === "tool_result",
  );
  assert.match(toolResult.event.content, /E2E-WEB-OUTSIDE/);

  const assistantText = client.messages
    .filter(
      (m) =>
        m.type === "event" &&
        (m.event.type === "assistant_text" ||
          m.event.type === "assistant_delta"),
    )
    .map((m) => m.event.text)
    .join("");
  assert.match(assistantText, /E2E-WEB-OK/);
  assert.ok(requests >= 2, "the provider ran the tool round-trip");

  // The same durable log the terminal would read.
  const sessionsDir = join(userConfigDir, "sessions");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length > 0, "a session log was written");
  const log = files
    .map((f) => readFileSync(join(sessionsDir, f), "utf8"))
    .join("\n");
  assert.match(log, /"user_message"/);
  assert.match(log, /"tool_result"/);
  assert.match(log, /E2E-WEB-OUTSIDE/);
  assert.match(log, /"assistant_message"/);

  client.ws.close();
  child?.kill("SIGTERM");
  const [code] = (await once(child!, "exit")) as [number | null];
  assert.equal(code, 0, "SIGTERM shuts the server down cleanly");
});
