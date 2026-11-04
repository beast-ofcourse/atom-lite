import { loadConfig } from "../config/load.js";
import {
  saveProviderModel,
  saveProviderSelection,
  saveTheme,
} from "../config/write.js";
import { resolveApiKey, saveApiKey } from "../config/credentials.js";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { openSearchablePicker, type PickerItem } from "./picker.js";
import { openCommandPalette, type PaletteItem } from "./palette.js";
import { bareCommandName, createCommandRegistry, type CommandContext } from "./commands.js";
import {
  resolveTheme,
  themeLabel,
  themeNames,
  type Theme,
} from "./theme.js";
import { SecretInput } from "./secret-input.js";
import { StatusLine } from "./status-line.js";
import { Activity } from "./activity.js";
import { ToolBox } from "./tool-box.js";
import { ApprovalPrompt, type ApprovalDecision } from "./approval-prompt.js";
import { Banner } from "./banner.js";
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
  isKeyRepeat,
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
  let themeOverride: string | undefined;
  let noColor = false;
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
    else if (a === "--theme") themeOverride = args[++i];
    else if (a === "--no-color") noColor = true;
    else if (a === "--no-tools") positional.push("__notools__");
    else if (a === "--help") {
      process.stdout.write(
        "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--no-tools] [--json] [--debug] [--theme NAME] [--no-color] [--version] [--help]\n",
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
  let session =
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

  const approvals: import("../runtime/approvals.js").ApprovalContext = {
    mode: (config.runtime.approvalMode as "ask" | "trusted" | "deny") ?? "ask",
    // Installed below once the interactive UI helpers exist.
    handler: undefined,
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

  let themeName = themeOverride ?? config.ui.theme;
  if (noColor) themeName = "ansi";
  let terminalScheme: "dark" | "light" | undefined;
  let theme: Theme = resolveTheme(themeName, {
    noColor,
    env: process.env,
    scheme: terminalScheme,
  });

  const transcript = new Transcript(theme);
  const banner = new Banner(theme);
  transcript.add(banner);
  transcript.add(new Spacer(1));
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
  // paddingY = 0 keeps the workspace path directly under the status line.
  const header = new Text(theme.tokens.dim(headerLabel()), 1, 0);

  const statusBar = new StatusLine(theme);
  const activity = new Activity({ theme, onChange: () => updateStatus() });
  statusBar.setParts({
    left: `${provider.id}/${(provider as any).model ?? "default"}`,
    tokens: "tokens: ?",
    effort: "effort: medium",
    activity: activity.text(),
  });

  const selectListTheme = {
    selectedPrefix: (s: string) => theme.tokens.accent(s),
    selectedText: (s: string) => theme.tokens.selection(s),
    description: (s: string) => theme.tokens.dim(s),
    scrollInfo: (s: string) => theme.tokens.dim(s),
    noMatch: (s: string) => theme.tokens.dim(s),
  };
  const editorTheme = {
    borderColor: (s: string) => theme.tokens.border(s),
    selectList: selectListTheme,
  };
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

  let commandRegistry = createCommandRegistry({ skills: skillReg.list() });
  let registrySkillSignature = skillSignature;
  function refreshCommandRegistry(): void {
    const sig = skillCacheSignature(process.cwd());
    if (sig === registrySkillSignature) return;
    commandRegistry = createCommandRegistry({ skills: cachedSkillRegistry().list() });
    registrySkillSignature = sig;
    input.setAutocompleteProvider(
      new CombinedAutocompleteProvider(commandRegistry.autocomplete() as any, process.cwd()),
    );
  }
  input.setAutocompleteProvider(
    new CombinedAutocompleteProvider(commandRegistry.autocomplete() as any, process.cwd()),
  );

  tui.addChild(output);
  tui.addChild(new Spacer());
  tui.addChild(input);
  tui.addChild(statusBar);
  // folder:branch info below the status line, dimmed
  tui.addChild(header);
  const dropdownContainer = new Container();
  tui.addChild(dropdownContainer);
  tui.setFocus(input);

  if (!noColor) {
    try {
      tui.setTerminalColorSchemeNotifications(true);
      tui.onTerminalColorSchemeChange((scheme) => {
        terminalScheme = scheme;
        if (themeName === "auto") applyTheme("auto", false);
      });
    } catch {
      // Terminals that do not support colour-scheme reports keep the
      // COLORFGBG/dark fallback.
    }
  }

  let thinkingText: any = null;
  let thinkingBuffer = "";
  let showThinking = config.ui.showThinking;
  let expandTools = false;
  let uiModalOpen = false;
  let closeActiveOverlay: (() => void) | undefined;
  const toolBoxes: ToolBox[] = [];

  /**
   * Close whichever modal overlay owns the keyboard. Callers that clear the
   * dropdown container directly must use this first, or the overlay's input
   * listener would keep consuming keys after it disappears from the screen.
   */
  function closeOverlay(): void {
    const close = closeActiveOverlay;
    closeActiveOverlay = undefined;
    close?.();
  }

  function appendLine(text: string): void {
    if (thinkingText) {
      thinkingText = null;
      thinkingBuffer = "";
    }
    streamText.finalize();
    transcript.addLine(text);
    tui.requestRender();
  }

  function appendDelta(delta: string): void {
    streamText.append(delta);
    tui.requestRender();
  }

  function thinkingBody(): string {
    return thinkingBuffer
      .split("\n")
      .map((line) => theme.tokens.dim(`| ${line}`))
      .join("\n");
  }

  function finalizeText(): void {
    streamText.finalize();
  }

  /** Run one interactive turn while keeping the status bar's activity fresh. */
  async function runTurn(prompt: string): Promise<void> {
    activity.start("formulating");
    const controller = new AbortController();
    try {
      await runtime.runAgentTurn(prompt, session, controller.signal);
    } catch (err) {
      appendLine(`atom-lite: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activity.stop();
    }
  }

  function updateStatus(): void {
    const usage = runtime.getContextUsage();
    statusBar.setParts({
      left: `${provider.id}/${currentModelLabel()}`,
      tokens: `tokens: ${formatContextUsage(usage.used, usage.window)}`,
      effort: `effort: ${effortLevel}`,
      activity: activity.text(),
    });
    tui.requestRender();
  }

  function currentModelLabel(): string {
    return modelOverride ?? (provider as any).model ?? "default";
  }

  function applyTheme(name: string, persist: boolean): void {
    themeName = name;
    theme = resolveTheme(name, {
      noColor,
      env: process.env,
      scheme: terminalScheme,
    });
    banner.setTheme(theme);
    transcript.setTheme(theme);
    statusBar.setTheme(theme);
    activity.setTheme(theme);
    header.setText(theme.tokens.dim(headerLabel()));
    if (persist) {
      try {
        saveTheme(name);
      } catch (err) {
        appendLine(
          `warning: could not persist theme: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    updateStatus();
    tui.requestRender();
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

  /** Providers whose model list is missing or older than the cache TTL. */
  function providersNeedingRefresh(names: string[]): string[] {
    return names.filter((name) => {
      const cached = modelCache.get(name);
      return !cached || Date.now() - cached.at >= MODEL_CACHE_TTL_MS;
    });
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

  /** Interpret `/model` arguments: bare model, provider/model, or provider. */
  function switchModelTarget(target: string): void {
    const rest = target.trim();
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
      theme,
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
    closeActiveOverlay = picker.close;
    const stale = providersNeedingRefresh(names);
    if (stale.length) {
      picker.setStatus(`loading live models from ${stale.length} provider${stale.length === 1 ? "" : "s"}…`);
      refreshModelCache(stale, () => {
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
    closeOverlay();
    dropdownContainer.clear();
    uiModalOpen = false;
    tui.setFocus(input);
    tui.requestRender();
  }

  function promptForApiKey(preset: ProviderPreset, existingKey: string | null): void {
    uiModalOpen = true;
    closeOverlay();
    dropdownContainer.clear();
    const wrapper = new Container();
    wrapper.addChild(new Text(theme.tokens.accent(`${preset.label} API key`)));
    if (preset.keyUrl) wrapper.addChild(new Text(theme.tokens.dim(`create one: ${preset.keyUrl}`)));
    if (existingKey) wrapper.addChild(new Text(theme.tokens.dim("a key is already saved — press Enter to keep it")));
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
        status.setText(theme.tokens.dim("an API key is required"));
        tui.requestRender();
        return;
      }
      busy = true;
      status.setText(theme.tokens.dim("validating key…"));
      tui.requestRender();
      await new Promise((r) => setImmediate(r));
      const probe = await probeApiKey(preset, key);
      if (probe.invalid) {
        busy = false;
        status.setText(theme.tokens.error(`✗ key rejected by ${preset.label}`));
        secret.reset();
        tui.requestRender();
        return;
      }
      try {
        saveApiKey(preset.id, key);
      } catch (err) {
        busy = false;
        status.setText(
          theme.tokens.error(
            `✗ could not save key: ${err instanceof Error ? err.message : String(err)}`,
          ),
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
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select provider",
      theme,
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
    closeActiveOverlay = picker.close;
  }

  function openEffortPicker(): void {
    uiModalOpen = true;
    const items = [
      { value: "low", label: "low", description: "minimal reasoning" },
      { value: "medium", label: "medium", description: "balanced" },
      { value: "high", label: "high", description: "deep reasoning" },
    ];
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select effort",
      theme,
      items,
      maxVisible: 3,
      onSelect: (item) => {
        uiModalOpen = false;
        setEffortTarget(item.value as "low" | "medium" | "high");
      },
      onCancel: () => {
        uiModalOpen = false;
        appendLine("cancelled");
      },
      restoreFocus: () => tui.setFocus(input),
    });
    closeActiveOverlay = picker.close;
    picker.setStatus("applies to the next turn");
  }

  function setEffortTarget(level: "low" | "medium" | "high"): void {
    effortLevel = level;
    runtime.setEffort(level);
    updateStatus();
    appendLine(`effort set to ${effortLevel}`);
  }

  function themePickerItems(): PickerItem[] {
    return themeNames().map((name) => ({
      value: name,
      label: name,
      description: themeLabel(name),
    }));
  }

  function setThemeTarget(name: string): void {
    if (!themeNames().includes(name)) {
      appendLine(
        `unknown theme: ${name} (available: ${themeNames().join(", ")})`,
      );
      return;
    }
    applyTheme(name, true);
    appendLine(`theme: ${themeLabel(name)}`);
  }

  function openThemePicker(): void {
    uiModalOpen = true;
    const original = themeName;
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select theme",
      theme,
      items: themePickerItems(),
      maxVisible: 4,
      initialValue: themeName,
      onPreview: (item) => applyTheme(item.value, false),
      onSelect: (item) => {
        uiModalOpen = false;
        setThemeTarget(item.value);
      },
      onCancel: () => {
        uiModalOpen = false;
        applyTheme(original, false);
        appendLine("cancelled");
      },
      restoreFocus: () => tui.setFocus(input),
    });
    closeActiveOverlay = picker.close;
  }

  async function loadSkill(name: string, extra: string): Promise<boolean> {
    const registry = cachedSkillRegistry();
    const content = registry.load(name);
    if (!content) {
      appendLine(`skill not found: ${name}`);
      return false;
    }
    session.appendMessage({ role: "system", content });
    if (typeof (session as any).appendEvent === "function") {
      session.appendEvent({ type: "skill_loaded", name });
    }
    appendLine(`Loaded skill: ${name}`);
    if (extra) {
      appendLine(`> ${extra}`);
      await runTurn(extra);
    }
    return true;
  }

  const commandContext: CommandContext = {
    get session() {
      return session;
    },
    runtime,
    approvals,
    appendLine,
    clearContent: () => {
      session.messages.length = 0;
      content.clear();
      tui.requestRender();
    },
    updateStatus,
    runDoctor,
    openModelPicker,
    openProviderPicker,
    openEffortPicker,
    openThemePicker,
    switchModel: switchModelTarget,
    startProviderSetup,
    setEffort: setEffortTarget,
    toggleThinking: () => {
      showThinking = !showThinking;
      return showThinking;
    },
    setTheme: setThemeTarget,
    listSkills: () =>
      cachedSkillRegistry().list().map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    loadSkill,
    runTurn,
    requestExit: () => {
      tui.stop();
      process.exit(0);
    },
  };

  function resumeSession(id: string): void {
    const next = store.resume(id);
    if (!next) {
      appendLine(`could not resume session: ${id}`);
      return;
    }
    session = next;
    if (typeof (session as any).appendEvent === "function") {
      session.appendEvent({ type: "session_resumed" });
    }
    appendLine(
      `resumed session ${session.id} (${session.messages.length} messages)`,
    );
  }

  function buildPaletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];

    for (const command of commandRegistry.list()) {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      items.push({
        id: `command:${command.name}`,
        label: `/${command.name}${hint}`,
        description: command.description,
        category: command.category,
        keywords: command.aliases,
        action: async () => {
          await commandRegistry.dispatch(`/${command.name}`, commandContext);
        },
      });
    }

    const profiles = new Set([
      ...availableProviderNames(config),
      ...Object.keys(config.providers as Record<string, unknown>),
    ]);
    for (const profile of profiles) {
      const preset = getPreset(profile);
      items.push({
        id: `provider:${profile}`,
        label: providerLabel(profile),
        description: preset?.description ?? "configured provider",
        category: "Providers",
        action: () => {
          if (preset) startProviderSetup(profile);
          else
            switchModelTarget(
              `${profile}/${String(profileConfig(profile)?.model ?? "default")}`,
            );
        },
      });
    }

    for (const item of buildModelItems()) {
      const separator = item.value.indexOf("\u0000");
      const profile = item.value.slice(0, separator);
      const model = item.value.slice(separator + 1);
      items.push({
        id: `model:${item.value}`,
        label: item.label.replace("  (current)", ""),
        description: `${providerLabel(profile)}${item.label.includes("(current)") ? " · current" : ""}`,
        category: "Models",
        action: () => switchToModel(profile, model),
      });
    }

    for (const name of themeNames()) {
      items.push({
        id: `theme:${name}`,
        label: name,
        description: themeLabel(name),
        category: "Themes",
        action: () => setThemeTarget(name),
      });
    }

    for (const summary of store.list(process.cwd()).slice(0, 8)) {
      items.push({
        id: `session:${summary.id}`,
        label: summary.id,
        description: `${summary.updatedAt ?? "unknown"} · ${summary.eventCount ?? 0} events`,
        category: "Sessions",
        keywords: [summary.provider],
        action: () => resumeSession(summary.id),
      });
    }

    return items;
  }

  function openPalette(): void {
    if (uiModalOpen) return;
    refreshCommandRegistry();
    uiModalOpen = true;
    const palette = openCommandPalette({
      tui,
      container: dropdownContainer,
      items: buildPaletteItems(),
      theme,
      title: "Command palette",
      onSelect: () => {
        uiModalOpen = false;
      },
      onCancel: () => {
        uiModalOpen = false;
        appendLine("cancelled");
      },
      onError: (err) => {
        uiModalOpen = false;
        appendLine(
          `palette: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
      restoreFocus: () => tui.setFocus(input),
    });
    closeActiveOverlay = palette.close;

    // The palette lists models too; refresh stale caches in the background and
    // update the open list when live discovery finishes.
    const stale = providersNeedingRefresh(availableProviderNames(config));
    if (stale.length) {
      refreshModelCache(stale, () => {
        palette.updateItems(buildPaletteItems());
      });
    }
  }

  function toggleTools(): void {
    expandTools = !expandTools;
    for (const box of toolBoxes) {
      box.setExpanded(expandTools);
    }
    tui.requestRender();
  }

  tui.addInputListener((data: string) => {
    // Releases and repeats must not toggle modal shortcuts twice.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    // Ctrl+P opens the command palette unless a modal owns the keyboard.
    if (matchesKey(data, Key.ctrl("p")) && !uiModalOpen) {
      openPalette();
      return { consume: true };
    }
    // Ctrl+O toggles tool expansion (unless a modal is capturing input).
    if (matchesKey(data, Key.ctrl("o")) && !uiModalOpen) {
      toggleTools();
      return { consume: true };
    }
    return undefined;
  });

  runtime["onEvent"] = (e: any) => {
    if (e.type === "thinking_delta") {
      activity.setPhase("thinking");
      if (!showThinking) return;
      if (!thinkingText) {
        thinkingText = new Text(theme.tokens.dim("Thinking..."));
        transcript.add(thinkingText);
        thinkingBuffer = "";
      }
      thinkingBuffer += e.text;
      thinkingText.setText(
        `${theme.tokens.dim("Thinking...")}\n${thinkingBody()}`,
      );
      tui.requestRender();
    } else if (e.type === "assistant_delta") {
      activity.setPhase("working");
      if (thinkingText) {
        thinkingText.setText(
          `${theme.tokens.dim("Thinking...")}\n${thinkingBody()}\n${theme.tokens.dim("| end")}`,
        );
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
    } else if (e.type === "assistant_text") {
      activity.setPhase("working");
      if (thinkingText) {
        thinkingText.setText(
          `${theme.tokens.dim("Thinking...")}\n${thinkingBody()}\n${theme.tokens.dim("| end")}`,
        );
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
      activity.setPhase("working", e.name);
      const box = new ToolBox({ id: e.id, name: e.name, args: e.args });
      box.setExpanded(expandTools);
      transcript.add(box);
      toolBoxes.push(box);
      tui.requestRender();
    } else if (e.type === "tool_output") {
      const box = toolBoxes.find((b) => b.id === e.toolCallId);
      if (box) {
        activity.setPhase("working", e.name);
        box.appendLive(e.text);
        tui.requestRender();
      }
    } else if (e.type === "tool_result") {
      const last =
        toolBoxes.find((b) => b.id === e.toolCallId) ??
        toolBoxes[toolBoxes.length - 1];
      if (last) {
        last.setResult(e.content, { isError: e.isError, diff: e.diff });
        activity.setPhase("working");
        tui.requestRender();
      }
    } else if (e.type === "final") {
      finalizeText();
      activity.stop();
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
    if (!trimmed) {
      tui.requestRender();
      return;
    }

    refreshCommandRegistry();
    if (trimmed.startsWith("/")) {
      const result = await commandRegistry.dispatch(trimmed, commandContext);
      if (result.exit) return;
      if (!result.handled) {
        appendLine(
          `unknown command: ${trimmed.split(/\s+/)[0]} (type /help for a list of commands)`,
        );
      }
      return;
    }

    // Skills remain invokable by bare name, but still run through the registry.
    const bare = bareCommandName(commandRegistry, trimmed);
    if (bare) {
      await commandRegistry.dispatch(`/${bare} ${trimmed.slice(bare.length)}`, commandContext);
      return;
    }

    appendLine(`> ${trimmed}`);
    await runTurn(trimmed);
  };

  approvals.handler = interactive
    ? (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          uiModalOpen = true;
          closeOverlay();
          dropdownContainer.clear();
          activity.setPhase("waiting");
          const prompt = new ApprovalPrompt(req, (decision) => {
            uiModalOpen = false;
            dropdownContainer.clear();
            tui.setFocus(input);
            activity.setPhase("working");
            if (decision === "trust-session") {
              appendLine("trusted this session: shell commands will run without approval");
            }
            resolve(decision);
          });
          dropdownContainer.addChild(prompt);
          tui.setFocus(prompt);
          tui.requestRender();
        })
    : undefined;

  tui.start();

  // Some terminals answer OSC 11 but not the colour-scheme report. Query the
  // background once and derive light/dark from its luminance.
  if (!noColor && typeof tui.queryTerminalColors === "function") {
    void tui
      .queryTerminalColors({ timeoutMs: 250 })
      .then((colors) => {
        const background = colors.background;
        if (!background) return;
        const luminance =
          (0.2126 * background.r +
            0.7152 * background.g +
            0.0722 * background.b) /
          255;
        terminalScheme = luminance > 0.5 ? "light" : "dark";
        if (themeName === "auto") applyTheme("auto", false);
      })
      .catch(() => {
        // Keep the static fallback.
      });
  }
}
