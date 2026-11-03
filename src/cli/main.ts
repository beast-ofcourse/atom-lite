#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { AgentRuntime } from "../agent/loop.js";
import { InMemorySession } from "../sessions/store.js";
import { readTool, writeTool, editTool, bashTool } from "../tools/index.js";
import { createProvider } from "../providers/factory.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let providerOverride: string | undefined;
  let modelOverride: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider") {
      providerOverride = args[++i];
    } else if (a === "--model") {
      modelOverride = args[++i];
    } else if (a.startsWith("--")) {
      // ignore unknown flags for skeleton
    } else {
      positional.push(a);
    }
  }
  const oneShot = positional.join(" ").trim();

  const config = loadConfig();
  const provider = createProvider(config, providerOverride, modelOverride);
  const tools = [readTool, writeTool, editTool, bashTool];
  const runtime = new AgentRuntime({
    provider,
    model: modelOverride,
    workspace: process.cwd(),
    tools,
  });

  if (oneShot) {
    const session = new InMemorySession("cli", process.cwd(), provider.id);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await runtime.runAgentTurn(
        oneShot,
        session,
        controller.signal,
      );
      process.stdout.write(result + "\n");
    } catch (err) {
      process.stderr.write(
        `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    } finally {
      process.off("SIGINT", onSigint);
    }
    return;
  }

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
      const result = await runtime.runAgentTurn(
        trimmed,
        session,
        controller.signal,
      );
      process.stdout.write(result + "\n");
    } catch (err) {
      process.stderr.write(
        `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      process.off("SIGINT", onSigint);
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(
    `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
