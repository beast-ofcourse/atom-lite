#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { AgentRuntime } from "../agent/loop.js";
import { InMemorySession } from "../sessions/store.js";
import { readTool, writeTool, editTool, bashTool } from "../tools/index.js";
import { createProvider } from "../providers/factory.js";
import { ContextManager } from "../context/manager.js";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let providerOverride: string | undefined;
  let modelOverride: string | undefined;
  let jsonMode = false;
  let debug = false;
  let showVersion = false;
  let sessionOverride: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider") providerOverride = args[++i];
    else if (a === "--model") modelOverride = args[++i];
    else if (a === "--json") jsonMode = true;
    else if (a === "--debug") debug = true;
    else if (a === "--version") showVersion = true;
    else if (a === "--help") {
      process.stdout.write(
        "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--no-tools] [--json] [--debug] [--version] [--help]\n",
      );
      return;
    } else if (a === "--continue") positional.push("__continue__");
    else if (a === "--session") sessionOverride = args[++i];
    else if (a === "--no-tools") positional.push("__notools__");
    else if (a.startsWith("--")) {
      // ignore
    } else {
      positional.push(a);
    }
  }

  if (showVersion) {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const config = loadConfig();
  const provider = createProvider(config, providerOverride, modelOverride);
  const useTools = !positional.includes("__notools__");
  const tools = useTools ? [readTool, writeTool, editTool, bashTool] : [];

  const interactive = process.stdin.isTTY === true && !jsonMode;
  let sessionTrusted = false;
  const approvals: import("../runtime/approvals.js").ApprovalContext = {
    mode: (config.runtime.approvalMode as "ask" | "trusted" | "deny") ?? "ask",
    handler: interactive
      ? async (req) => {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer: string = await new Promise((resolve) => {
            rl.question(
              `Approve command?\n  ${req.command}\n  cwd: ${req.cwd}\n  timeout: ${req.timeoutMs}ms\n  sandboxed: ${req.sandboxed}\n  [y]es / [n]o / [t]rust session: `,
              resolve,
            );
          });
          rl.close();
          const a = answer.trim().toLowerCase();
          if (a === "t" || a === "trust") return "trust-session";
          if (a === "y" || a === "yes") return "approve";
          return "deny";
        }
      : undefined,
    isTrusted: () => sessionTrusted,
    trustSession: () => {
      sessionTrusted = true;
    },
    nonInteractive: !interactive,
  };

  const contextManager = new ContextManager({
    systemPrompt: "You are a coding assistant.",
    maxInputTokens: config.context.maxInputTokens ?? null,
    reserveOutputTokens: config.context.reserveOutputTokens,
    compactAtPercent: config.context.compactAtPercent,
    maxProjectInstructionBytes: config.context.maxProjectInstructionBytes,
    provider,
    model: modelOverride ?? "default",
    userInstructionsPath: undefined,
  });

  const runtime = new AgentRuntime({
    provider,
    model: modelOverride,
    workspace: process.cwd(),
    tools,
    approvals,
    contextManager,
  });

  // Read task from stdin if not a TTY and no positional args
  let stdinTask = "";
  if (
    !process.stdin.isTTY &&
    positional.filter((p) => !p.startsWith("__")).length === 0
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    stdinTask = Buffer.concat(chunks).toString("utf8").trim();
  }

  const taskArgs = positional.filter((p) => !p.startsWith("__"));
  const oneShot = (taskArgs.join(" ").trim() || stdinTask).trim();

  async function runOneShot(task: string): Promise<void> {
    const { JsonlSessionStore } = await import("../sessions/store.js");
    const store = new JsonlSessionStore();
    let session: any;
    if (sessionOverride) session = store.resume(sessionOverride);
    else if (positional.includes("__continue__"))
      session = store.resumeLatest(process.cwd());
    if (!session) session = store.create(process.cwd(), provider.id);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await runtime.runAgentTurn(
        task,
        session,
        controller.signal,
      );
      if (jsonMode) {
        process.stdout.write(
          JSON.stringify({ result, sessionId: session.id }) + "\n",
        );
      } else {
        process.stdout.write(result + "\n");
      }
    } catch (err) {
      if (jsonMode) {
        process.stderr.write(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
      } else {
        process.stderr.write(
          `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.exit(1);
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  if (oneShot) {
    await runOneShot(oneShot);
    return;
  }

  // Interactive REPL
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { JsonlSessionStore } = await import("../sessions/store.js");
  const store = new JsonlSessionStore();
  let session: any;
  if (sessionOverride) session = store.resume(sessionOverride);
  else if (positional.includes("__continue__"))
    session = store.resumeLatest(process.cwd());
  if (!session) session = store.create(process.cwd(), provider.id);
  rl.setPrompt("atom-lite> ");
  rl.prompt();

  async function runDoctor(): Promise<string> {
    const lines: string[] = [];
    lines.push("Doctor:");
    // config validity
    try {
      loadConfig();
      lines.push("  config: ok");
    } catch (e) {
      lines.push(
        `  config: FAIL ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // provider connectivity
    try {
      const r = await provider.generate({
        model: modelOverride ?? "default",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        tools: [],
      });
      lines.push(`  provider generate: ok (${r.finishReason})`);
    } catch (e) {
      lines.push(
        `  provider generate: FAIL ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // tool-call capability (harmless)
    try {
      const r = await provider.generate({
        model: modelOverride ?? "default",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Call the noop tool with no arguments." },
            ],
          },
        ],
        tools: [
          {
            name: "noop",
            description: "A harmless no-op tool.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      lines.push(
        `  tool-call capability: ${r.toolCalls.length ? "ok" : "not observed"}`,
      );
    } catch (e) {
      lines.push(
        `  tool-call capability: FAIL ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // model info
    if (typeof provider.getModelInfo === "function") {
      try {
        const info = await provider.getModelInfo();
        lines.push(`  model info: ${info ? JSON.stringify(info) : "unknown"}`);
      } catch (e) {
        lines.push(
          `  model info: FAIL ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      lines.push("  model info: not supported by provider");
    }
    // workspace read/write
    try {
      const tmp = join(process.cwd(), `.atom-doctor-${Date.now()}`);
      writeFileSync(tmp, "ok");
      const read = readFileSync(tmp, "utf8");
      unlinkSync(tmp);
      lines.push(`  workspace rw: ok (${read})`);
    } catch (e) {
      lines.push(
        `  workspace rw: FAIL ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return lines.join("\n");
  }

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === "/exit") {
      rl.close();
      return;
    }
    if (trimmed === "/help") {
      process.stdout.write(
        [
          "/help",
          "/model",
          "/session",
          "/compact",
          "/clear",
          "/approval",
          "/doctor",
          "/exit",
        ].join("\n") + "\n",
      );
      rl.prompt();
      return;
    }
    if (trimmed === "/session") {
      process.stdout.write(
        `session: ${session.id}\nworkspace: ${session.workspace}\nprovider: ${session.provider}\nmessages: ${session.messages.length}\n`,
      );
      rl.prompt();
      return;
    }
    if (trimmed === "/approval") {
      process.stdout.write(
        `approval mode: ${approvals.mode}\ntrusted this session: ${approvals.isTrusted()}\n`,
      );
      rl.prompt();
      return;
    }
    if (trimmed === "/doctor") {
      const out = await runDoctor();
      process.stdout.write(out + "\n");
      rl.prompt();
      return;
    }
    if (trimmed === "/clear") {
      session.messages.length = 0;
      process.stdout.write("started new session\n");
      rl.prompt();
      return;
    }
    if (trimmed === "/compact") {
      // trigger by rebuilding context not needed; just acknowledge
      process.stdout.write("compaction is automatic; nothing to do\n");
      rl.prompt();
      return;
    }
    if (trimmed.startsWith("/model")) {
      process.stdout.write(
        "model switching at safe boundaries is not implemented in this skeleton\n",
      );
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
