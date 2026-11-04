import { loadConfig } from "../config/load.js";
import { saveProviderModel, saveProviderSelection } from "../config/write.js";
import { resolveApiKey, saveApiKey } from "../config/credentials.js";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { openSearchablePicker, type PickerItem } from "./picker.js";
import { SecretInput } from "./secret-input.js";
import { StatusLine } from "./status-line.js";
import {
  formatContextUsage,
  knownContextWindow,
} from "../providers/context-window.js";
import { StreamText } from "./stream-text.js";
import { Transcript } from "./transcript.js";
import { AgentRuntime } from "../agent/loop.js";
import { JsonlSessionStore } from "../sessions/store.js";
import { readTool, writeTool, editTool, bashTool, webfetchTool, websearchTool } from "../tools/index.js";
import { createProvider } from "../providers/factory.js";
import {
  availableProviderNames,
  getPreset,
  listModelsForProvider,
  materializeProviderConfig,
  probeApiKey,
  providerLabel,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../providers/catalog.js";
import { ContextManager } from "../context/manager.js";
import {
  ProcessTerminal,
  TuiMainScreen,
  Text,
  Input,
  Container,
  Spacer,
  isKeyRelease,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";

export async function run(args: string[]): Promise<void> {
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

  let config = loadConfig();
  const initialProfile = providerOverride ?? config.defaultProvider;
  if (!(config.providers as Record<string, unknown>)[initialProfile]) {
    const preset = getPreset(initialProfile);
    if (preset) {
      (config.providers as Record<string, unknown>)[initialProfile] =
        materializeProviderConfig(preset);
    }
  }
  let provider = createProvider(config, providerOverride, modelOverride);
  const modelByProvider = new Map<string, string>();
  if (modelOverride) modelByProvider.set(provider.id, modelOverride);
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
    bashConcurrency: config.runtime.bashConcurrency,
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
  const { TuiMainScreen, Text, Input, Editor, Container, Spacer, ScrollView, Loader, Markdown, Box } =
    await import("@earendil-works/pi-tui");

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  let effortLevel = "medium";
  runtime.setEffort(effortLevel);

  const transcript = new Transcript();
  const content = transcript.container;
  const output = new ScrollView(content, { follow: "end" });
  const streamText = new StreamText(transcript);

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
  // paddingY = 0 keeps the workspace path directly under the status line.
  const header = new Text(dim(headerLabel()), 1, 0);

  const statusBar = new StatusLine();
  statusBar.setParts({
    left: dim(`${provider.id}/${(provider as any).model ?? "default"}`),
    tokens: dim("tokens: ?"),
    effort: dim("effort: medium"),
  });

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
  const { DefaultSkillRegistry, skillCacheSignature } = await import("../skills/registry.js");
  let skillSignature = skillCacheSignature(process.cwd());
  let skillReg = new DefaultSkillRegistry(process.cwd());
  function cachedSkillRegistry(): InstanceType<typeof DefaultSkillRegistry> {
    const sig = skillCacheSignature(process.cwd());
    if (sig !== skillSignature) {
      skillReg = new DefaultSkillRegistry(process.cwd());
      skillSignature = sig;
    }
    return skillReg;
  }
  const slashCommands: { name: string; description?: string }[] = [
    { name: "help", description: "show commands" },
    { name: "model", description: "search/switch model" },
    { name: "provider", description: "add/select provider" },
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

  let thinkingText: any = null;
  let thinkingBuffer = "";
  let showThinking = true;
  let loader: any = null;
  let expandTools = false;
  let uiModalOpen = false;
  const toolBoxes: {
    id: string;
    header: any;
    output: any;
    container: any;
    lines: string[];
    toolName?: string;
    args?: any;
    live?: any;
    liveBuffer?: string;
  }[] = [];

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
    streamText.finalize();
    transcript.add(new Text(text));
    tui.requestRender();
  }

  function appendDelta(delta: string): void {
    streamText.append(delta);
    tui.requestRender();
  }

  function finalizeText(): void {
    streamText.finalize();
  }

  function updateStatus(): void {
    const usage = runtime.getContextUsage();
    statusBar.setParts({
      left: dim(`${provider.id}/${currentModelLabel()}`),
      tokens: dim(`tokens: ${formatContextUsage(usage.used, usage.window)}`),
      effort: dim(`effort: ${effortLevel}`),
    });
    tui.requestRender();
  }

  function currentModelLabel(): string {
    return modelOverride ?? (provider as any).model ?? "default";
  }

  /**
   * Show the best-known window immediately, then refine it from live provider
   * metadata without blocking the TUI.
   */
  function refreshContextWindow(): void {
    const profile = provider.id;
    const model = currentModelLabel();
    const configured = profileConfig(profile)?.contextWindow;
    const window =
      typeof configured === "number" && configured > 0
        ? configured
        : knownContextWindow(model);
    runtime.setContextWindow(window);
    updateStatus();

    const getModelInfo = (provider as any).getModelInfo;
    if (typeof getModelInfo !== "function") return;
    void Promise.resolve()
      .then(() => getModelInfo.call(provider))
      .then((info: any) => {
        if (provider.id !== profile || currentModelLabel() !== model) return;
        const resolved = info?.contextWindow;
        if (typeof resolved === "number" && resolved > 0) {
          runtime.setContextWindow(resolved);
          updateStatus();
        }
      })
      .catch(() => {
        // Keep the static/config fallback.
      });
  }

  // Resolve the initial model's window before the first response.
  refreshContextWindow();

  const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  const modelCache = new Map<string, { models: string[]; at: number }>();

  function profileConfig(profile: string): Record<string, any> | undefined {
    return (config.providers as Record<string, any>)[profile];
  }

  /** Ensure a preset profile exists in the in-memory config. */
  function ensureProfile(profile: string): Record<string, any> | undefined {
    let pcfg = profileConfig(profile);
    if (pcfg) return pcfg;
    const preset = getPreset(profile);
    if (!preset) return undefined;
    pcfg = materializeProviderConfig(preset);
    (config.providers as Record<string, any>)[profile] = pcfg;
    saveProviderSelection(profile, pcfg);
    return pcfg;
  }

  function modelsFor(profile: string): string[] {
    const cached = modelCache.get(profile);
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }
    const pcfg = profileConfig(profile);
    const preset = getPreset(profile);
    const fallback = [
      ...(preset?.fallbackModels ?? []),
      ...(pcfg?.model ? [String(pcfg.model)] : []),
    ];
    return [...new Set(fallback.filter(Boolean))];
  }

  function buildModelItems(): PickerItem[] {
    const names = availableProviderNames(config);
    if (!names.includes(provider.id) && profileConfig(provider.id)) {
      names.unshift(provider.id);
    } else {
      const idx = names.indexOf(provider.id);
      if (idx > 0) {
        names.splice(idx, 1);
        names.unshift(provider.id);
      }
    }
    const items: PickerItem[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      let pcfg = profileConfig(name);
      if (!pcfg) {
        const preset = getPreset(name);
        if (!preset) continue;
        // Materialize env/credential-only presets in memory so they appear in
        // the picker without being written to disk until the user picks one.
        pcfg = materializeProviderConfig(preset);
        (config.providers as Record<string, any>)[name] = pcfg;
      }
      for (const model of modelsFor(name)) {
        const value = `${name}\u0000${model}`;
        if (seen.has(value)) continue;
        seen.add(value);
        const isCurrent = name === provider.id && model === currentModelLabel();
        items.push({
          value,
          label: `${model}${isCurrent ? "  (current)" : ""}`,
          description: providerLabel(name),
        });
      }
    }
    return items;
  }

  function refreshModelCache(
    names: string[],
    onUpdate: () => void,
  ): void {
    if (names.length === 0) return;
    let remaining = names.length;
    for (const name of names) {
      void listModelsForProvider(config, name, 8000).then((models) => {
        if (models.length) {
          const configured = profileConfig(name)?.model;
          modelCache.set(name, {
            models: [
              ...new Set([
                ...(configured ? [String(configured)] : []),
                ...models,
              ]),
            ],
            at: Date.now(),
          });
        }
        remaining--;
        if (remaining === 0) onUpdate();
      });
    }
  }

  function switchToModel(profile: string, model: string): void {
    const pcfg = ensureProfile(profile);
    if (!pcfg) {
      appendLine(`unknown provider: ${profile}`);
      return;
    }
    pcfg.model = model;
    config.defaultProvider = profile;
    try {
      saveProviderSelection(profile, { model }, { defaultProvider: profile });
    } catch (err) {
      appendLine(`warning: could not persist model choice: ${err instanceof Error ? err.message : String(err)}`);
    }
    modelByProvider.set(profile, model);
    modelOverride = model;
    provider = createProvider(config, profile, model);
    runtime.switchModel(provider, model);
    refreshContextWindow();
    appendLine(`switched to ${profile}/${model}`);
  }

  function openModelPicker(): void {
    const names = availableProviderNames(config);
    if (!names.includes(provider.id) && profileConfig(provider.id)) {
      names.unshift(provider.id);
    }
    uiModalOpen = true;
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select model",
      items: buildModelItems(),
      maxVisible: 15,
      onSelect: (item) => {
        uiModalOpen = false;
        const sep = item.value.indexOf("\u0000");
        const profile = item.value.slice(0, sep);
        const model = item.value.slice(sep + 1);
        switchToModel(profile, model);
      },
      onCancel: () => {
        uiModalOpen = false;
        appendLine("cancelled");
      },
      restoreFocus: () => tui.setFocus(input),
    });
    if (names.length) {
      picker.setStatus(`loading live models from ${names.length} provider${names.length === 1 ? "" : "s"}…`);
      refreshModelCache(names, () => {
        picker.setStatus("");
        picker.updateItems(buildModelItems());
      });
    }
  }

  function providerItems(): PickerItem[] {
    return PROVIDER_PRESETS.map((preset) => {
      const configured = Boolean(profileConfig(preset.id));
      const key = preset.requiresKey
        ? resolveApiKey(preset.id, { apiKeyEnv: preset.keyEnv })
        : null;
      const status = !preset.requiresKey
        ? preset.local
          ? "local · no key"
          : "no key"
        : key
          ? "key saved"
          : preset.keyEnv
            ? `needs key (${preset.keyEnv})`
            : "needs key";
      return {
        value: preset.id,
        label: `${configured ? "✓ " : "  "}${preset.label}`,
        description: `${preset.description} · ${status}`,
      };
    });
  }

  function activateProvider(preset: ProviderPreset, models?: string[]): void {
    const existing = profileConfig(preset.id);
    const pcfg = materializeProviderConfig(preset, existing);
    (config.providers as Record<string, any>)[preset.id] = pcfg;
    config.defaultProvider = preset.id;
    saveProviderSelection(preset.id, pcfg, { defaultProvider: preset.id });
    if (models?.length) {
      modelCache.set(preset.id, {
        models: [...new Set([String(pcfg.model), ...models])],
        at: Date.now(),
      });
    }
    const chosen = modelByProvider.get(preset.id) ?? String(pcfg.model);
    pcfg.model = chosen;
    modelOverride = chosen;
    provider = createProvider(config, preset.id, chosen);
    runtime.switchModel(provider, chosen);
    if (typeof (session as any).appendEvent === "function") {
      session.appendEvent({ type: "provider_selected", provider: preset.id, model: chosen });
    }
    refreshContextWindow();
    appendLine(`provider: ${preset.label} (${preset.id}) · model: ${chosen}`);
    appendLine("tip: /model searches every configured provider");
  }

  function closeApiKeyPrompt(): void {
    dropdownContainer.clear();
    uiModalOpen = false;
    tui.setFocus(input);
    tui.requestRender();
  }

  function promptForApiKey(preset: ProviderPreset, existingKey: string | null): void {
    uiModalOpen = true;
    dropdownContainer.clear();
    const wrapper = new Container();
    wrapper.addChild(new Text(`\x1b[36m${preset.label} API key\x1b[0m`));
    if (preset.keyUrl) wrapper.addChild(new Text(dim(`create one: ${preset.keyUrl}`)));
    if (existingKey) wrapper.addChild(new Text(dim("a key is already saved — press Enter to keep it")));
    const secret = new SecretInput(
      "API key",
      existingKey ? "hidden (Enter keeps saved key)" : "paste key (hidden)",
    );
    const status = new Text("");
    wrapper.addChild(secret);
    wrapper.addChild(status);
    dropdownContainer.addChild(wrapper);
    tui.setFocus(secret);
    tui.requestRender();

    let busy = false;
    secret.onCancel = () => {
      if (busy) return;
      closeApiKeyPrompt();
      appendLine(`cancelled ${preset.label} setup`);
    };
    secret.onSubmit = async (value: string) => {
      if (busy) return;
      const key = value.trim();
      if (!key) {
        if (existingKey) {
          closeApiKeyPrompt();
          try {
            activateProvider(preset);
          } catch (err) {
            appendLine(`could not activate ${preset.label}: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        status.setText(dim("an API key is required"));
        tui.requestRender();
        return;
      }
      busy = true;
      status.setText(dim("validating key…"));
      tui.requestRender();
      await new Promise((r) => setImmediate(r));
      const probe = await probeApiKey(preset, key);
      if (probe.invalid) {
        busy = false;
        status.setText(`\x1b[31m✗ key rejected by ${preset.label}\x1b[0m`);
        secret.reset();
        tui.requestRender();
        return;
      }
      try {
        saveApiKey(preset.id, key);
      } catch (err) {
        busy = false;
        status.setText(
          `\x1b[31m✗ could not save key: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        tui.requestRender();
        return;
      }
      closeApiKeyPrompt();
      if (!probe.ok) {
        appendLine(`warning: could not verify ${preset.label} key (${probe.error ?? "network error"}); saved anyway`);
      }
      try {
        activateProvider(preset, probe.models);
      } catch (err) {
        appendLine(
          `could not activate ${preset.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
  }

  function startProviderSetup(profile: string): void {
    const preset = getPreset(profile);
    if (!preset) {
      appendLine(`unknown provider: ${profile}`);
      return;
    }
    if (!preset.requiresKey) {
      try {
        activateProvider(preset);
      } catch (err) {
        appendLine(`could not activate ${preset.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    const existingKey = resolveApiKey(preset.id, { apiKeyEnv: preset.keyEnv });
    promptForApiKey(preset, existingKey);
  }

  function openProviderPicker(): void {
    uiModalOpen = true;
    openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select provider",
      items: providerItems(),
      maxVisible: 12,
      onSelect: (item) => {
        uiModalOpen = false;
        startProviderSetup(item.value);
      },
      onCancel: () => {
        uiModalOpen = false;
        appendLine("cancelled");
      },
      restoreFocus: () => tui.setFocus(input),
    });
  }

  appendLineFn = appendLine;

  function toggleTools(): void {
    expandTools = !expandTools;
    for (const box of toolBoxes) {
      if (box.live) continue; // a running command keeps its live view
      box.output.clear();
      if (expandTools) {
        if (box.lines.length > 0) {
          box.output.addChild(new Text(box.lines.join("\n")));
        }
      } else {
        box.output.addChild(new Text(`  (${box.lines.length} lines, ctrl+o to expand)`));
      }
    }
    tui.requestRender();
  }

  tui.addInputListener((data: string) => {
    // Ctrl+O toggles tool expansion (unless a modal is capturing input).
    if (matchesKey(data, Key.ctrl("o")) && !uiModalOpen) {
      toggleTools();
      return { consume: true };
    }
    return undefined;
  });

  runtime["onEvent"] = (e: any) => {
    if (e.type === "thinking_delta") {
      if (!showThinking) return;
      if (!thinkingText) {
        thinkingText = new Text("\x1b[2mThinking...\x1b[0m");
        transcript.add(thinkingText);
        thinkingBuffer = "";
      }
      thinkingBuffer += e.text;
      const prefixed = thinkingBuffer
        .split("\n")
        .map((l: string) => `\x1b[2m| ${l}\x1b[0m`)
        .join("\n");
      thinkingText.setText(`\x1b[2mThinking...\x1b[0m\n${prefixed}`);
      tui.requestRender();
    } else if (e.type === "assistant_delta") {
      if (thinkingText) {
        const prefixed = thinkingBuffer
          .split("\n")
          .map((l: string) => `\x1b[2m| ${l}\x1b[0m`)
          .join("\n");
        thinkingText.setText(`\x1b[2mThinking...\x1b[0m\n${prefixed}\n\x1b[2m| end\x1b[0m`);
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
    } else if (e.type === "assistant_text") {
      if (thinkingText) {
        const prefixed = thinkingBuffer
          .split("\n")
          .map((l: string) => `\x1b[2m| ${l}\x1b[0m`)
          .join("\n");
        thinkingText.setText(`\x1b[2mThinking...\x1b[0m\n${prefixed}\n\x1b[2m| end\x1b[0m`);
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
      finalizeText();
    } else if (e.type === "context_usage") {
      updateStatus();
    } else if (e.type === "model_switched") {
      appendLine(`switched model to ${e.provider}/${e.model}`);
      if (typeof (session as any).appendEvent === "function") {
        session.appendEvent({ type: "model_switched", provider: e.provider, model: e.model });
      }
      updateStatus();
    } else if (e.type === "tool_call") {
      finalizeText();
      const box = new Container();
      const header = new Text(`▸ ${e.name} ${JSON.stringify(e.args)}`);
      box.addChild(header);
      const output = new Container();
      box.addChild(output);
      transcript.add(box);
      toolBoxes.push({
        id: e.id,
        header,
        output,
        container: box,
        lines: [],
        toolName: e.name,
        args: e.args,
      });
      tui.requestRender();
    } else if (e.type === "tool_output") {
      const box = toolBoxes.find((b) => b.id === e.toolCallId);
      if (box) {
        if (!box.live) {
          box.live = new Text("");
          box.output.addChild(box.live);
        }
        box.liveBuffer = (box.liveBuffer ?? "") + e.text;
        // Keep the live view bounded; the completed result carries the full
        // capped output, and the JSONL transcript keeps everything.
        if (box.liveBuffer.length > 60_000) {
          box.liveBuffer = box.liveBuffer.slice(-60_000);
        }
        box.live.setText(box.liveBuffer);
        tui.requestRender();
      }
    } else if (e.type === "tool_result") {
      const last =
        toolBoxes.find((b) => b.id === e.toolCallId) ??
        toolBoxes[toolBoxes.length - 1];
      if (last) {
        last.live = null;
        last.liveBuffer = "";
        last.output.clear();
        if (e.diff) {
          const diffLines: string[] = e.diff;
          last.lines = diffLines;
          if (expandTools) {
            const colored = diffLines
              .map((l) =>
                l.startsWith("+")
                  ? `\x1b[32m${l}\x1b[0m`
                  : l.startsWith("-")
                    ? `\x1b[31m${l}\x1b[0m`
                    : l,
              )
              .join("\n");
            if (colored) last.output.addChild(new Text(colored));
          } else {
            const added = diffLines.filter((l) => l.startsWith("+")).length;
            const removed = diffLines.filter((l) => l.startsWith("-")).length;
            last.output.addChild(new Text(`  +${added} -${removed} (ctrl+o to expand)`));
          }
        } else {
          const lines = e.content.split("\n");
          last.lines = lines;
          if (expandTools) {
            last.output.addChild(new Text(lines.join("\n")));
          } else {
            last.output.addChild(new Text(`  (${lines.length} lines, ctrl+o to expand)`));
          }
        }
        tui.requestRender();
      }
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
    const _skillReg = cachedSkillRegistry();
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
      appendLine(["/help", "/model", "/provider", "/session", "/compact", "/clear", "/approval", "/doctor", "/effort", "/thinking", "/exit"].join("\n"));
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
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      const rest = trimmed.slice("/model".length).trim();
      if (!rest) {
        openModelPicker();
        return;
      }
      const knownModels = modelsFor(provider.id);
      if (knownModels.includes(rest)) {
        switchToModel(provider.id, rest);
        return;
      }
      const slash = rest.indexOf("/");
      if (slash > 0) {
        const profile = rest.slice(0, slash);
        const model = rest.slice(slash + 1);
        if (profileConfig(profile) || getPreset(profile)) {
          switchToModel(profile, model);
          return;
        }
      }
      if (profileConfig(rest) || getPreset(rest)) {
        ensureProfile(rest);
        const pcfg = profileConfig(rest);
        switchToModel(rest, String(pcfg?.model ?? modelOverride ?? "default"));
        return;
      }
      switchToModel(provider.id, rest);
      return;
    }
    if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
      const rest = trimmed.slice("/provider".length).trim();
      if (rest) startProviderSetup(rest);
      else openProviderPicker();
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
        // Skip kitty-protocol key-release events to avoid double moves.
        if (isKeyRelease(data)) return { consume: true };
        selectList.handleInput(data);
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