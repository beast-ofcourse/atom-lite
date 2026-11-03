#!/usr/bin/env node
import { loadConfig } from "../config/load.js";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { AgentRuntime } from "../agent/loop.js";
import { JsonlSessionStore } from "../sessions/store.js";
import { readTool, writeTool, editTool, bashTool, webfetchTool, websearchTool } from "../tools/index.js";
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
  let provider = createProvider(config, providerOverride, modelOverride);
  const useTools = !positional.includes("__notools__");
  const tools = useTools ? [readTool, writeTool, editTool, bashTool, webfetchTool, websearchTool] : [];

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
  runtime.setEffort(effortLevel);

  const content = new Container();
  const output = new ScrollView(content, { follow: "end" });

  function headerLabel(): string {
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    let displayPath = cwd;
    if (home && cwd.startsWith(home)) displayPath = "~" + cwd.slice(home.length);
    let branch = "";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (branch === "HEAD") {
        branch = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      }
    } catch {
      branch = "";
    }
    return branch ? `${displayPath}:${branch}` : displayPath;
  }
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const header = new Text(dim(headerLabel()));

  const statusProvider = new Text(dim(`${provider.id}/${(provider as any).model ?? "default"}`));
  const statusTokens = new Text(dim("tokens: 0/0"));
  const statusEffort = new Text(dim("effort: medium"));
  const statusBar = new HStack([statusProvider, new Spacer(), statusTokens, new Spacer(), statusEffort]);

  const selectListTheme = {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => `\x1b[7m${s}\x1b[0m`,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  };
  const editorTheme = { borderColor: (s: string) => s, selectList: selectListTheme };
  const input = new Editor(tui, editorTheme, {});
  const { CombinedAutocompleteProvider } = await import("@earendil-works/pi-tui");
  const { DefaultSkillRegistry } = await import("../skills/registry.js");
  const skillReg = new DefaultSkillRegistry(process.cwd());
  const slashCommands: { name: string; description?: string }[] = [
    { name: "help", description: "show commands" },
    { name: "model", description: "show/switch model" },
    { name: "session", description: "session info" },
    { name: "compact", description: "compact history" },
    { name: "clear", description: "clear session" },
    { name: "approval", description: "approval mode" },
    { name: "doctor", description: "diagnostics" },
    { name: "effort", description: "set effort level" },
    { name: "skills", description: "list/select skills" },
    { name: "exit", description: "exit" },
  ];
  for (const s of skillReg.list()) {
    slashCommands.push({ name: s.name, description: s.description });
  }
  input.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands as any, process.cwd()));

  tui.addChild(output);
  tui.addChild(new Spacer());
  tui.addChild(input);
  tui.addChild(statusBar);
  // folder:branch info below the status line, dimmed
  tui.addChild(header);
  const dropdownContainer = new Container();
  tui.addChild(dropdownContainer);
  tui.setFocus(input);

  let currentText: any = null;
  let currentBuffer = "";
  let thinkingText: any = null;
  let thinkingBuffer = "";
  let showThinking = true;
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
    if (thinkingText) {
      thinkingText = null;
      thinkingBuffer = "";
    }
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
    statusTokens.setText(dim(`tokens: ${totalInputTokens}/${totalOutputTokens}`));
    statusEffort.setText(dim(`effort: ${effortLevel}`));
    statusProvider.setText(dim(`${provider.id}/${modelOverride ?? (provider as any).model ?? "default"}`));
    tui.requestRender();
  }

  appendLineFn = appendLine;

  runtime["onEvent"] = (e: any) => {
    if (e.type === "thinking_delta") {
      if (!showThinking) return;
      if (!thinkingText) {
        thinkingText = new Text("\\x1b[2mThinking...\\x1b[0m");
        content.addChild(thinkingText);
        thinkingBuffer = "";
      }
      thinkingBuffer += e.text;
      const prefixed = thinkingBuffer
        .split("\\n")
        .map((l: string) => `\\x1b[2m| ${l}\\x1b[0m`)
        .join("\\n");
      thinkingText.setText(`\\x1b[2mThinking...\\x1b[0m\\n${prefixed}`);
      tui.requestRender();
    } else if (e.type === "assistant_delta") {
      if (thinkingText) {
        const prefixed = thinkingBuffer
          .split("\\n")
          .map((l: string) => `\\x1b[2m| ${l}\\x1b[0m`)
          .join("\\n");
        thinkingText.setText(`\\x1b[2mThinking...\\x1b[0m\\n${prefixed}\\n\\x1b[2m| end\\x1b[0m`);
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
    } else if (e.type === "assistant_text") {
      if (thinkingText) {
        const prefixed = thinkingBuffer
          .split("\\n")
          .map((l: string) => `\\x1b[2m| ${l}\\x1b[0m`)
          .join("\\n");
        thinkingText.setText(`\\x1b[2mThinking...\\x1b[0m\\n${prefixed}\\n\\x1b[2m| end\\x1b[0m`);
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
      finalizeText();
    } else if (e.type === "usage") {
      totalInputTokens += e.input ?? 0;
      totalOutputTokens += e.output ?? 0;
      updateStatus();
    } else if (e.type === "model_switched") {
      appendLine(`switched model to ${e.provider}/${e.model}`);
      updateStatus();
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
    const firstToken = trimmed.split(/\s+/)[0].replace(/^\//, "");
    const { DefaultSkillRegistry: _DSR } = await import("../skills/registry.js");
    const _skillReg = new _DSR(process.cwd());
    const isSkill = _skillReg.list().some((s: any) => s.name === firstToken) || trimmed.startsWith("/skill ");
    if (isSkill) {
      const skillName = trimmed.startsWith("/skill ") ? trimmed.split(/\s+/)[1] : firstToken;
      const content = _skillReg.load(skillName);
      if (!content) {
        appendLine(`skill not found: ${skillName}`);
        return;
      }
      session.appendMessage({ role: "system", content });
      if (typeof session.appendEvent === "function") {
        session.appendEvent({ type: "skill_loaded", name: skillName });
      }
      appendLine(`Loaded skill: ${skillName}`);
      const extra = trimmed.startsWith("/skill ")
        ? trimmed.split(/\s+/).slice(2).join(" ").trim()
        : trimmed.slice(firstToken.length + 1).trim();
      if (extra) {
        appendLine(`> ${extra}`);
        const controller = new AbortController();
        try {
          await runtime.runAgentTurn(extra, session, controller.signal);
        } catch (err) {
          appendLine(`atom-lite: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    if (trimmed === "/exit") { tui.stop(); process.exit(0); return; }
    if (trimmed === "/help") {
      appendLine(["/help", "/model", "/session", "/compact", "/clear", "/approval", "/doctor", "/effort", "/thinking", "/exit"].join("\n"));
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
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const profile = parts[1];
        const newProvider = createProvider(config, profile, modelOverride);
        runtime.switchModel(newProvider, modelOverride);
        provider = newProvider;
        appendLine(`switched to ${profile}`);
        updateStatus();
        return;
      }
      // Interactive dropdown of models from the provider
      let models: string[] = [];
      if (typeof (provider as any).listModels === "function") {
        try {
          models = await (provider as any).listModels();
        } catch {
          models = [];
        }
      }
      if (models.length === 0) models = [(provider as any).model ?? "default"];
      const items = models.map((m: string) => ({ value: m, label: m.length > 40 ? m.slice(0, 37) + "..." : m, description: m.length > 40 ? m : "" }));
      const { SelectList } = await import("@earendil-works/pi-tui");
      const selectListTheme = {
        selectedPrefix: (s: string) => s,
        selectedText: (s: string) => `\x1b[7m${s}\x1b[0m`,
        description: (s: string) => s,
        scrollInfo: (s: string) => s,
        noMatch: (s: string) => s,
      };
      const selectList = new SelectList(items as any, Math.min(15, items.length), selectListTheme as any);
      dropdownContainer.addChild(selectList);
      tui.requestRender();
      const removeListener = tui.addInputListener((data: string) => {
        const before = (selectList as any).selectedIndex;
        selectList.handleInput(data);
        const after = (selectList as any).selectedIndex;
        console.error("DEBUG handleInput:", JSON.stringify(data), before, "->", after);
        tui.requestRender();
        return { consume: true };
      });
      selectList.onSelect = (item: any) => {
        removeListener();
        const newModel = item.value;
        runtime.switchModel(provider, newModel);
        modelOverride = newModel;
        dropdownContainer.clear();
        tui.setFocus(input);
        appendLine(`switched to ${provider.id}/${newModel}`);
        updateStatus();
      };
      selectList.onCancel = () => {
        removeListener();
        dropdownContainer.clear();
        tui.setFocus(input);
        appendLine("cancelled");
      };
      return;
    }
    if (trimmed === "/skills") {
      const reg = new (await import("../skills/registry.js")).DefaultSkillRegistry(process.cwd());
      const skills = reg.list();
      if (skills.length === 0) {
        appendLine("no skills available");
        return;
      }
      appendLine(skills.map((sk: any) => `${sk.name} - ${sk.description}`).join("\n"));
      return;
    }
    if (trimmed.startsWith("/skill ")) {
      const name = trimmed.split(/\s+/)[1];
      const reg = new (await import("../skills/registry.js")).DefaultSkillRegistry(process.cwd());
      const content = reg.load(name);
      if (!content) {
        appendLine(`skill not found: ${name}`);
        return;
      }
      session.appendMessage({ role: "system", content });
      if (typeof session.appendEvent === "function") {
        session.appendEvent({ type: "skill_loaded", name });
      }
      appendLine(`Loaded skill: ${name}`);
      const extra = trimmed.split(/\s+/).slice(2).join(" ").trim();
      if (extra) {
        appendLine(`> ${extra}`);
        const controller = new AbortController();
        try {
          await runtime.runAgentTurn(extra, session, controller.signal);
        } catch (err) {
          appendLine(`atom-lite: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    if (trimmed === "/thinking") {
      showThinking = !showThinking;
      appendLine(`thinking display: ${showThinking ? "shown" : "hidden"}`);
      return;
    }
    if (trimmed.startsWith("/effort")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const lvl = parts[1];
        if (lvl === "low" || lvl === "medium" || lvl === "high") {
          effortLevel = lvl;
          runtime.setEffort(lvl);
          updateStatus();
          appendLine(`effort set to ${effortLevel}`);
        } else {
          appendLine("usage: /effort low|medium|high");
        }
        return;
      }
      // Interactive dropdown
      const items = [
        { value: "low", label: "low", description: "minimal reasoning" },
        { value: "medium", label: "medium", description: "balanced" },
        { value: "high", label: "high", description: "deep reasoning" },
      ];
      const { SelectList } = await import("@earendil-works/pi-tui");
      const selectListTheme = {
        selectedPrefix: (s: string) => s,
        selectedText: (s: string) => `\x1b[7m${s}\x1b[0m`,
        description: (s: string) => s,
        scrollInfo: (s: string) => s,
        noMatch: (s: string) => s,
      };
      const selectList = new SelectList(items as any, 3, selectListTheme as any);
      dropdownContainer.addChild(selectList);
      tui.requestRender();
      const removeListener = tui.addInputListener((data: string) => {
        const before = (selectList as any).selectedIndex;
        selectList.handleInput(data);
        const after = (selectList as any).selectedIndex;
        console.error("DEBUG handleInput:", JSON.stringify(data), before, "->", after);
        tui.requestRender();
        return { consume: true };
      });
      selectList.onSelect = (item: any) => {
        removeListener();
        const lvl = item.value;
        effortLevel = lvl;
        runtime.setEffort(lvl);
        dropdownContainer.clear();
        tui.setFocus(input);
        updateStatus();
        appendLine(`effort set to ${effortLevel}`);
      };
      selectList.onCancel = () => {
        removeListener();
        dropdownContainer.clear();
        tui.setFocus(input);
        appendLine("cancelled");
      };
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