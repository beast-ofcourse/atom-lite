import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpManager, createMcpTools } from "../../dist/mcp/index.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "mcp-server.mjs",
);

test(
  "stdio smoke (opt-in)",
  { skip: !process.env.ATOM_LITE_MCP_SMOKE },
  async () => {
    const manager = new McpManager({
      servers: {
        smoke: {
          command: process.execPath,
          args: [fixture],
          enabled: true,
          startupTimeoutMs: 5000,
          callTimeoutMs: 5000,
          env: {},
        },
      },
    });
    const tools = await manager.syncTools();
    assert.equal(tools.length, 1);
    const [tool] = createMcpTools(manager);
    const res = await tool.execute(
      { id: "1", name: tool.definition.name, arguments: { text: "hi" } },
      { workspace: process.cwd(), signal: new AbortController().signal },
    );
    assert.equal(res.isError, false);
    assert.match(res.content, /echo:hi/);
    await manager.close();
  },
);
