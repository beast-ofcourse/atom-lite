import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TUNNEL_COMMAND,
  extractTunnelUrl,
  startTunnel,
  tokenizeCommand,
  tunnelHostname,
} from "../../dist/web/tunnel.js";

test("tunnel commands tokenize without a shell and keep quoted arguments", () => {
  assert.deepEqual(
    tokenizeCommand(
      'my-tunnel --url "http://127.0.0.1:{port}" --label "my phone"',
    ),
    ["my-tunnel", "--url", "http://127.0.0.1:{port}", "--label", "my phone"],
  );
  assert.deepEqual(tokenizeCommand("  "), []);
  assert.throws(() => tokenizeCommand('bad "quote'), /unterminated/);
});

test("provider output yields the assigned HTTPS URL", () => {
  const output = [
    "docs at https://github.com/cloudflare/cloudflared",
    "https://demo.trycloudflare.com",
    "",
  ].join("\n");
  assert.equal(extractTunnelUrl(output), "https://demo.trycloudflare.com/");
  assert.equal(extractTunnelUrl("waiting http://127.0.0.1:7317"), undefined);
  assert.equal(extractTunnelUrl("bad https://"), undefined);
});

test("tunnel hostname is lowercased and usable as an allowlist entry", () => {
  assert.equal(
    tunnelHostname("https://Phone-Tunnel.Example.test/path"),
    "phone-tunnel.example.test",
  );
  assert.equal(tunnelHostname("not a url"), undefined);
});

test("default command targets the requested local port", () => {
  assert.match(DEFAULT_TUNNEL_COMMAND, /\{port\}/);
  assert.deepEqual(tokenizeCommand(DEFAULT_TUNNEL_COMMAND), [
    "cloudflared",
    "tunnel",
    "--url",
    "http://127.0.0.1:{port}",
  ]);
});

test("a tunnel handle resolves from provider output and closes cleanly", async () => {
  const script =
    "console.error('https://demo.trycloudflare.com'); setInterval(() => {}, 1000);";
  const command = `${process.execPath} -e "${script}"`;
  const handle = await startTunnel({ port: 7317, command, timeoutMs: 3000 });
  assert.equal(handle.url, "https://demo.trycloudflare.com/");
  await handle.close();
  await handle.close();
});

test("a failing tunnel command reports the provider output", async () => {
  const command = `${process.execPath} -e "console.error('provider refused'); process.exit(2)"`;
  await assert.rejects(
    startTunnel({ port: 7317, command, timeoutMs: 3000 }),
    /provider refused/,
  );
});
