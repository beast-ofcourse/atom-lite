#!/usr/bin/env node
// Minimal MCP stdio server used by the opt-in smoke test.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "smoke" },
      });
    } else if (msg.method === "notifications/initialized") {
      // no response
    } else if (msg.method === "tools/list") {
      respond(msg.id, {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    } else if (msg.method === "tools/call") {
      respond(msg.id, {
        content: [{ type: "text", text: `echo:${msg.params.arguments.text}` }],
        isError: false,
      });
    } else if (msg.id !== undefined) {
      respond(msg.id, {}, true);
    }
  }
});

function respond(id, result, isError = false) {
  const msg = isError
    ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

process.stdin.resume();
