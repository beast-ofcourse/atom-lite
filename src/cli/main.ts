#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { AgentRuntime } from "../agent/loop.js";
import { FakeProvider } from "../providers/fake.js";
import { InMemorySession } from "../sessions/store.js";
import { InMemoryToolRegistry } from "../tools/registry.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const oneShot = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  const config = loadConfig();
  const provider = new FakeProvider([{ text: "Hello from atom-lite skeleton." }]);
  const tools = new InMemoryToolRegistry();
  const runtime = new AgentRuntime({ provider, tools: tools.definitions() });

  if (oneShot) {
    const session = new InMemorySession("cli", process.cwd(), provider.id);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await runtime.runAgentTurn(oneShot, session, controller.signal);
      process.stdout.write(result + "\n");
    } finally {
      process.off("SIGINT", onSigint);
    }
    return;
  }

  // Minimal interactive loop
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const session = new InMemorySession("cli", process.cwd(), provider.id);
  rl.setPrompt("atom-lite> ");
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (trimmed === "/exit") {
      rl.close();
      return;
    }
    if (!trimmed) {
      rl.prompt();
      return;
    }
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await runtime.runAgentTurn(trimmed, session, controller.signal);
      process.stdout.write(result + "\n");
    } catch (err) {
      process.stderr.write(`atom-lite: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.off("SIGINT", onSigint);
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(`atom-lite: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});