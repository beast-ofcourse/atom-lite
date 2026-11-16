// E2E: share mode keeps the runtime on loopback but publishes the web UI
// through an outbound tunnel. The tunnel command is faked so CI never needs a
// third-party service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";

interface Fixture {
  root: string;
  project: string;
  home: string;
  configHome: string;
  agentDir: string;
  marker: string;
  tunnelScript: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "atom-e2e-share-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const configHome = join(root, "config");
  const configDir = join(configHome, "atom-lite");
  const agentDir = join(root, "agent");
  for (const dir of [project, home, configDir, agentDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configDir, "config.json"), "{}");
  const marker = join(root, "marker.txt");
  const tunnelScript = join(root, "fake-tunnel.mjs");
  writeFileSync(
    tunnelScript,
    [
      'import { writeFileSync } from "node:fs";',
      "const [marker, port] = process.argv.slice(2);",
      'writeFileSync(marker, "started");',
      "console.error(`https://phone-${port}.trycloudflare.com`);",
      'process.on("SIGTERM", () => { writeFileSync(marker, "stopped"); process.exit(0); });',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  return {
    root,
    project,
    home,
    configHome,
    agentDir,
    marker,
    tunnelScript,
  };
}

function launch(env: Fixture, tunnelCommand: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli", "main.js"),
      "--serve",
      "0",
      "--share",
      "--tunnel-command",
      tunnelCommand,
      "--no-qr",
    ],
    {
      cwd: env.project,
      env: {
        ...process.env,
        HOME: env.home,
        XDG_CONFIG_HOME: env.configHome,
        PI_CODING_AGENT_DIR: env.agentDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}:\n${output}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve(match);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`share command exited (${code}):\n${output}`));
    });
  });
}

function rawStatus(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("share mode accepts only the published tunnel host", async () => {
  const env = fixture();
  const command = `${process.execPath} ${env.tunnelScript} ${env.marker} {port}`;
  const child = launch(env, command);
  try {
    const ready = await waitForOutput(
      child,
      /local web UI at (http:\/\/\S+)[\s\S]*?shared UI at (https:\/\/\S+)/,
    );
    const shareUrl = new URL(ready[2]);
    const token = shareUrl.searchParams.get("token");
    assert.ok(token, "published URL includes the run token");
    const allowedHost = shareUrl.hostname;
    const localPort = Number(new URL(ready[1]).port);

    const path = `/?token=${encodeURIComponent(token)}`;
    assert.equal(
      await rawStatus(localPort, path, { host: allowedHost }),
      200,
      "the published host is accepted",
    );
    assert.equal(
      await rawStatus(localPort, path, { host: "evil.example.test" }),
      403,
      "a foreign host is still forbidden",
    );
    assert.equal(
      await rawStatus(localPort, "/", { host: allowedHost }),
      401,
      "the token is still required",
    );

    const ws = new WebSocket(
      `ws://127.0.0.1:${localPort}/?token=${encodeURIComponent(token)}`,
      { headers: { Host: allowedHost } },
    );
    await once(ws, "open");
    const hello = await once(ws, "message");
    assert.equal(JSON.parse(hello[0].toString()).type, "hello");
    ws.close();

    assert.equal(readFileSync(env.marker, "utf8"), "started");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  assert.equal(readFileSync(env.marker, "utf8"), "stopped");
});

test("share mode reports a failing tunnel and leaves no server", async () => {
  const env = fixture();
  const command = `${process.execPath} -e "console.error('provider refused'); process.exit(2)"`;
  const child = launch(env, command);
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const [code] = await once(child, "exit");
  const text = output.join("");
  assert.equal(code, 1);
  assert.match(text, /provider refused/);
  assert.doesNotMatch(text, /shared UI at/);
});
