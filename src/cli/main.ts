#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { join } from "node:path";
import { AgentRuntime } from "../agent/loop.js";
import { JsonlSessionStore } from "../sessions/store.js";
import { readTool, writeTool, editTool, bashTool } from "../tools/index.js";
import { createProvider } from "../providers/factory.js";
import { ContextManager } from "../context/manager.js";
import { ProcessTerminal, TuiMainScreen, Text, Input, Container, Spacer } from "@earendil-works/pi-tui";

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
    else if (a === "--continue") positional.push("__continue__");
    else if (a === "--session") sessionOverride = args[++i];
    else if (a === "--no-tools") positional.push("__notools__");
    else if (a === "--help") {
      process.stdout.write(
        "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--no-tools] [--json] [--debug] [--version] [--help]\n",
      );
      return;
    } else if (a.startsWith("--")) {
      // ignore
    } else {
      positional.push(a);
    }
  }

  if (showVersion) {
    process.stdout.write("0.1.0\n");
    return;
  }

  const config = loadConfig();
  const provider = createProvider(config, providerOverride, modelOverride);
  const useTools = !positional.includes("__notools__");
  const tools = useTools ? [readTool, writeTool, editTool, bashTool] : [];

  const interactive = process.stdin.isTTY === true && !jsonMode;

  // one-shot task from positional or stdin
  let stdinTask = "";
  if (!process.stdin.isTTY && positional.filter((p) => !p.startsWith("__")).length === 0) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    stdinTask = Buffer.concat(chunks).toString("utf8").trim();
  }
  const taskArgs = positional.filter((p) => !p.startsWith("__"));
  const oneShot = (taskArgs.join(" ").trim() || stdinTask).trim();

  const store = new JsonlSessionStore();
  const session =
    sessionOverride
      ? store.resume(sessionOverride) ?? store.create(process.cwd(), provider.id)
      : positional.includes("__continue__")
        ? store.resumeLatest(process.cwd()) ?? store.create(process.cwd(), provider.id)
        : store.create(process.cwd(), provider.id);

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

  let sessionTrusted = false;
  let appendLineFn: (t: string) => void = () => {};
  let pendingApproval: ((d: "approve" | "deny" | "trust-session") => void) | null = null;

  const approvals: import("../runtime/approvals.js").ApprovalContext = {
    mode: (config.runtime.approvalMode as "ask" | "trusted" | "deny") ?? "ask",
    handler: interactive
      ? async (req) => {
          appendLineFn(`[approval] ${req.command}`);
          appendLineFn(`  cwd: ${req.cwd}  timeout: ${req.timeoutMs}ms  sandboxed: ${req.sandboxed}`);
          appendLineFn("  type y (approve) / n (deny) / t (trust session)");
          return new Promise<"approve" | "deny" | "trust-session">((resolve) => {
            pendingApproval = (d) => {
              pendingApproval = null;
              resolve(d);
            };
          });
        }
      : undefined,
    isTrusted: () => sessionTrusted,
    trustSession: () => {
      sessionTrusted = true;
    },
    nonInteractive: !interactive,
  };

  const runtime = new AgentRuntime({
    provider,
    model: modelOverride,
    workspace: process.cwd(),
    tools,
    approvals,
    contextManager,
    onEvent: (e) => {
      if (e.type === "assistant_delta") appendDelta(e.text);
      else if (e.type === "assistant_text") { appendDelta(e.text); finalizeText(); }
      else if (e.type === "tool_call") { finalizeText(); appendLine(`[tool] ${e.name} ${JSON.stringify(e.args)}`); }
      else if (e.type === "tool_result") appendLine(`  -> ${e.content.split("\\n")[0]}`);
      else if (e.type === "final") { finalizeText(); }
    },
  });

  if (oneShot || !interactive) {
    // non-interactive / one-shot path
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await runtime.runAgentTurn(oneShot || " ", session, controller.signal);
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ result, sessionId: session.id }) + "\n");
      } else {
        process.stdout.write(result + "\n");
      }
    } catch (err) {
      if (jsonMode) process.stderr.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + "\n");
      else process.stderr.write(`atom-lite: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    } finally {
      process.off("SIGINT", onSigint);
    }
    return;
  }

  // ---- Interactive TUI (first-class) ----
  const { TuiMainScreen, Text, Input, Editor, Container, Spacer, ScrollView, HStack, VStack, Loader, Markdown, Box } =
    await import("@earendil-works/pi-tui");

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let effortLevel = "medium";

  const content = new Container();
  const output = new ScrollView(content, { follow: "end" });

  const statusProvider = new Text("provider/model");
  const statusTokens = new Text("tokens: 0/0");
  const statusEffort = new Text("effort: medium");
  const statusBar = new HStack([statusProvider, new Spacer(), statusTokens, new Spacer(), statusEffort]);

  const selectListTheme = {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  };
  const editorTheme = { borderColor: (s: string) => s, selectList: selectListTheme };
  const input = new Editor(tui, editorTheme, {});
  const { CombinedAutocompleteProvider } = await import("@earendil-works/pi-tui");
  const slashCommands = [
    { name: "help", description: "show commands" },
    { name: "model", description: "show/switch model" },
    { name: "session", description: "session info" },
    { name: "compact", description: "compact history" },
    { name: "clear", description: "clear session" },
    { name: "approval", description: "approval mode" },
    { name: "doctor", description: "diagnostics" },
    { name: "effort", description: "set effort level" },
    { name: "exit", description: "exit" },
  ];
  input.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands as any, process.cwd()));

  tui.addChild(output);
  tui.addChild(new Spacer());
  tui.addChild(statusBar);
  tui.addChild(input);
  tui.setFocus(input);

  let currentText: any = null;
  let currentBuffer = "";
  let loader: any = null;

  approvals.handler = interactive
    ? async (req: any) => {
        appendLine("box: approval");
        appendLine(req.command);
        appendLine("type y / n / t");
        return new Promise<any>((resolve) => {
          pendingApproval = (d) => {
            pendingApproval = null;
            resolve(d);
          };
        });
      }
    : undefined;

  function appendLine(text: string): void {
    if (currentText) {
      currentText = null;
      currentBuffer = "";
    }
    for (const line of text.split("\n")) {
      content.addChild(new Text(line));
    }
    tui.requestRender();
  }

  function appendDelta(delta: string): void {
    if (!currentText) {
      currentText = new Text("");
      content.addChild(currentText);
      currentBuffer = "";
    }
    currentBuffer += delta;
    currentText.setText(currentBuffer);
    tui.requestRender();
  }

  function finalizeText(): void {
    currentText = null;
    currentBuffer = "";
  }

  function updateStatus(): void {
    statusTokens.setText(`tokens: ${totalInputTokens}/${totalOutputTokens}`);
    statusEffort.setText(`effort: ${effortLevel}`);
    statusProvider.setText(`${provider.id}/${modelOverride ?? "default"}`);
    tui.requestRender();
  }

  appendLineFn = appendLine;

  runtime["onEvent"] = (e: any) => {
    if (e.type === "assistant_delta") appendDelta(e.text);
    else if (e.type === "assistant_text") {
      appendDelta(e.text);
      finalizeText();
    } else if (e.type === "tool_call") {
      finalizeText();
      appendLine(`[tool] ${e.name} ${JSON.stringify(e.args)}`);
    } else if (e.type === "tool_result") {
      appendLine(`  -> ${e.content.split("\n")[0]}`);
    } else if (e.type === "final") {
      finalizeText();
    }
  };

  async function runDoctor(): Promise<string> {
    const lines: string[] = ["Doctor:"];
    try { loadConfig(); lines.push("  config: ok"); }
    catch (e) { lines.push(`  config: FAIL ${e instanceof Error ? e.message : String(e)}`); }
    try {
      const r = await provider.generate({ model: modelOverride ?? "default", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [] });
      lines.push(`  provider generate: ok (${r.finishReason})`);
    } catch (e) { lines.push(`  provider generate: FAIL ${e instanceof Error ? e.message : String(e)}`); }
    return lines.join("\n");
  }

  input.onSubmit = async (value: string) => {
    const trimmed = value.trim();
    input.setText("");
    if (pendingApproval) {
      const a = trimmed.toLowerCase();
      if (a === "y" || a === "yes") pendingApproval("approve");
      else if (a === "t" || a === "trust") pendingApproval("trust-session");
      else pendingApproval("deny");
      return;
    }
    if (!trimmed) { tui.requestRender(); return; }
    if (trimmed === "/exit") { tui.stop(); process.exit(0); return; }
    if (trimmed === "/help") {
      appendLine(["/help", "/model", "/session", "/compact", "/clear", "/approval", "/doctor", "/effort", "/exit"].join("\n"));
      return;
    }
    if (trimmed === "/session") {
      appendLine(`session: ${session.id}\nworkspace: ${session.workspace}\nprovider: ${session.provider}\nmessages: ${session.messages.length}`);
      return;
    }
    if (trimmed === "/approval") {
      appendLine(`approval mode: ${approvals.mode}\ntrusted this session: ${approvals.isTrusted()}`);
      return;
    }
    if (trimmed === "/doctor") {
      const out = await runDoctor();
      appendLine(out);
      return;
    }
    if (trimmed === "/clear") {
      session.messages.length = 0;
      content.clear();
      tui.requestRender();
      appendLine("started new session");
      return;
    }
    if (trimmed === "/compact") {
      appendLine("compaction is automatic");
      return;
    }
    if (trimmed.startsWith("/model")) {
      appendLine("model switching at safe boundaries is not implemented in this skeleton");
      return;
    }
    if (trimmed.startsWith("/effort")) {
      const lvl = trimmed.split(/\s+/)[1];
      if (lvl === "low" || lvl === "medium" || lvl === "high") {
        effortLevel = lvl;
        updateStatus();
        appendLine(`effort set to ${effortLevel}`);
      } else {
        appendLine("usage: /effort low|medium|high");
      }
      return;
    }
    appendLine(`> ${trimmed}`);
    const controller = new AbortController();
    try {
      await runtime.runAgentTurn(trimmed, session, controller.signal);
    } catch (err) {
      appendLine(`atom-lite: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // fix approvals handler to use appendLine (defined above via closure var)
  approvals.handler = interactive
    ? async (req: any) => {
        appendLine("┌─ approval ─────────────────────────────");
        appendLine(`│ ${req.command}`);
        appendLine(`│ cwd: ${req.cwd}  timeout: ${req.timeoutMs}ms  sandboxed: ${req.sandboxed}`);
        appendLine("│ [y]es / [n]o / [t]rust session");
        appendLine("└────────────────────────────────────────");
        return new Promise<any>((resolve) => {
          pendingApproval = (d) => {
            pendingApproval = null;
            resolve(d);
          };
        });
      }
    : undefined;

  tui.start();
}

main().catch((err) => {
  process.stderr.write(`atom-lite: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});