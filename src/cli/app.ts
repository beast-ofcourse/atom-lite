import { loadConfig } from "../config/load.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/system-prompt.js";
import {
  defaultAgentDir,
  defaultUserConfigPath,
  userConfigDir,
} from "../config/paths.js";
import {
  saveProviderModel,
  saveProviderSelection,
  saveTheme,
} from "../config/write.js";
import { resolveApiKey, saveApiKey } from "../config/credentials.js";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { defaultShell, terminateProcessTree } from "../security/process.js";
import { openSearchablePicker, type PickerItem } from "./picker.js";
import { openCommandPalette, type PaletteItem } from "./palette.js";
import {
  bareCommandName,
  createCommandRegistry,
  type CommandContext,
} from "./commands.js";
import {
  resolveTheme,
  themeLabel,
  themeNames,
  type Theme,
  markdownThemeFor,
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
  knownVisionModel,
} from "../providers/context-window.js";
import { StreamText } from "./stream-text.js";
import { initLsp, shutdownLsp } from "../lsp/index.js";
import { Transcript } from "./transcript.js";
import { AgentRuntime } from "../agent/loop.js";
import { JsonlSessionStore } from "../sessions/store.js";
import { ExtensionLoader } from "../extensions/loader.js";
import { createDefaultExtensionUI } from "../extensions/ui.js";
import type { ExtensionUICallbacks } from "../extensions/ui.js";
import { collectExtensionTools } from "../extensions/tool-adapter.js";
import { denyProject, trustProject } from "../extensions/trust.js";
import { ProjectTrustPrompt } from "./trust-prompt.js";
import {
  formatSessionList,
  formatSessionSearch,
  searchSessions,
  sessionTitleFromEvents,
} from "../sessions/search.js";
import {
  providerSwitchNotice,
  sessionHistoryLines,
  sessionSelectionFromEvents,
} from "../sessions/history.js";
import {
  blockAtLine,
  createMouseCapture,
  handleMouseEvent,
  parseSgrMouse,
  shouldEnableMouse,
} from "./mouse.js";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
  webfetchTool,
  websearchTool,
  grepTool,
  globTool,
  taskTool,
  todoTool,
  lspDiagnosticsTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspSymbolsTool,
} from "../tools/index.js";
import {
  McpManager,
  formatMcpStatus,
  formatMcpDoctor,
  createMcpTools,
} from "../mcp/index.js";
import { createProvider } from "../providers/factory.js";
import { setHeader } from "../providers/http-headers.js";
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
  TuiAltScreen,
  Text,
  Input,
  Container,
  Spacer,
  VStack,
  ScrollView,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  wrapTextWithAnsi,
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
  let listSessions = false;
  let searchSessionsQuery: string | undefined;
  const positional: string[] = [];
  const extensionPaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e" || a === "--extension") {
      const path = args[++i];
      if (path) extensionPaths.push(path);
    } else if (a === "--provider") providerOverride = args[++i];
    else if (a === "--model") modelOverride = args[++i];
    else if (a === "--json") jsonMode = true;
    else if (a === "--debug") debug = true;
    else if (a === "--version") showVersion = true;
    else if (a === "--continue") positional.push("__continue__");
    else if (a === "--session") sessionOverride = args[++i];
    else if (a === "--list-sessions") listSessions = true;
    else if (a === "--search-sessions") searchSessionsQuery = args[++i] ?? "";
    else if (a === "--theme") themeOverride = args[++i];
    else if (a === "--no-color") noColor = true;
    else if (a === "--no-tools") positional.push("__notools__");
    else if (a === "--help") {
      process.stdout.write(
        "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--list-sessions] [--search-sessions QUERY] [--no-tools] [--json] [--debug] [--theme NAME] [--no-color] [-e PATH] [--version] [--help]\n",
      );
      return;
    } else if (a.startsWith("--")) {
      // ignore
    } else {
      positional.push(a);
    }
  }

  if (showVersion) {
    const { VERSION } = await import("../version.js");
    process.stdout.write(VERSION + "\n");
    return;
  }

  if (listSessions || searchSessionsQuery !== undefined) {
    const store = new JsonlSessionStore();
    if (listSessions) {
      process.stdout.write(`${formatSessionList(store.list())}\n`);
    }
    if (searchSessionsQuery !== undefined) {
      const query = searchSessionsQuery.trim();
      if (!query) {
        process.stderr.write("atom-lite: --search-sessions requires a query\n");
        process.exitCode = 1;
        return;
      }
      const matches = searchSessions(store.list(), query);
      process.stdout.write(`${formatSessionSearch(matches)}\n`);
    }
    return;
  }

  let config = loadConfig();
  initLsp(config, process.cwd());
  const shutdownLspOnce = () => {
    void shutdownLsp();
  };
  process.on("exit", shutdownLspOnce);
  process.on("SIGINT", () => {
    void shutdownLsp().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdownLsp().finally(() => process.exit(0));
  });
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
  const builtInTools = useTools
    ? [
        readTool,
        writeTool,
        editTool,
        bashTool,
        webfetchTool,
        websearchTool,
        grepTool,
        globTool,
        taskTool,
        todoTool,
        ...(config.lsp?.enabled
          ? [
              lspDiagnosticsTool,
              lspDefinitionTool,
              lspReferencesTool,
              lspSymbolsTool,
            ]
          : []),
      ]
    : [];

  const interactive = process.stdin.isTTY === true && !jsonMode;

  // one-shot task from positional or stdin
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

  const store = new JsonlSessionStore();
  let session = sessionOverride
    ? (store.resume(sessionOverride) ??
      store.create(process.cwd(), provider.id))
    : positional.includes("__continue__")
      ? (store.resumeLatest(process.cwd()) ??
        store.create(process.cwd(), provider.id))
      : store.create(process.cwd(), provider.id);

  const mcpServers = (config.mcpServers ?? {}) as Record<string, any>;
  const mcpManager = new McpManager({
    servers: mcpServers as any,
    onEvent: (event) => {
      try {
        (session as any)?.appendEvent?.(event);
      } catch {
        // Observability must not break the session.
      }
    },
  });

  const extensionUICallbacks: ExtensionUICallbacks = {};
  const extensionProviderNames = new Set<string>();
  function resolveExtensionApiKey(value: unknown): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    if (value.startsWith("!")) {
      try {
        const { execFileSync } = require("node:child_process");
        const parts = value.slice(1).trim().split(/\s+/);
        return execFileSync(parts[0], parts.slice(1), {
          encoding: "utf8",
        }).trim();
      } catch {
        return undefined;
      }
    }
    if (value.startsWith("$")) return process.env[value.slice(1)] ?? value;
    if (value.startsWith("${") && value.endsWith("}"))
      return process.env[value.slice(2, -1)] ?? value;
    return value;
  }
  const extensionLoader = new ExtensionLoader({
    cliPaths: extensionPaths,
    cwd: process.cwd(),
    agentDir: defaultAgentDir(),
    userDir: join(userConfigDir(), "extensions"),
    projectDir: process.cwd(),
    hasUI: interactive,
    uiFactory: (registries, ctx) =>
      createDefaultExtensionUI(registries, ctx, extensionUICallbacks),
  });
  const pendingTrust = extensionLoader
    .discover()
    .filter(
      (entry) =>
        entry.source === "project" &&
        !entry.trusted &&
        entry.skipReason === "project is not trusted",
    );
  if (!interactive && pendingTrust.length > 0) {
    process.stderr.write(
      `atom-lite: skipping ${pendingTrust.length} untrusted project extension(s); run interactively to review\n`,
    );
  }
  await extensionLoader.loadAll().catch(() => {
    // Extension failures are reported per extension.
  });
  // Remove any previously bridged extension providers before re-bridging.
  for (const name of extensionProviderNames) {
    delete (config.providers as Record<string, any>)[name];
  }
  extensionProviderNames.clear();

  // Bridge Pi-style extension providers into Atom-lite's config so they
  // appear in /provider, /model, and the command palette.
  for (const loaded of extensionLoader.list()) {
    for (const [name, provider] of loaded.registries?.providers ?? new Map()) {
      const cfg = (provider as any)?.config ?? {};
      const firstModel =
        Array.isArray(cfg.models) && cfg.models.length > 0
          ? (cfg.models[0].id ?? cfg.models[0].name ?? "default")
          : "default";
      const apiKey = resolveExtensionApiKey(cfg.apiKey);
      const headers = { ...(cfg.headers as Record<string, string> | undefined) };
      if (cfg.authHeader && apiKey) {
        setHeader(headers, "Authorization", `Bearer ${apiKey}`);
      }
      (config.providers as Record<string, any>)[name] = {
        type: "openai-compatible",
        baseUrl: cfg.baseUrl,
        model: firstModel,
        apiKey: apiKey ?? null,
        apiKeyEnv: null,
        headers,
        contextWindow: cfg.models?.[0]?.contextWindow,
      };
      extensionProviderNames.add(name);
    }
  }

  const extensionTools = collectExtensionTools(extensionLoader);
  const allTools = [...builtInTools, ...extensionTools];
  const extensionDispatch = async (event: string, payload: any) => {
    const results: any[] = [];
    for (const loaded of extensionLoader.list()) {
      const handlers = loaded.registries.handlers.get(event as any);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          results.push(await handler(payload, loaded.context ?? ({} as any)));
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            `[extension:${loaded.id}] handler error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return results;
  };

  const contextManager = new ContextManager({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxInputTokens: config.context.maxInputTokens ?? null,
    reserveOutputTokens: config.context.reserveOutputTokens,
    compactAtPercent: config.context.compactAtPercent,
    maxProjectInstructionBytes: config.context.maxProjectInstructionBytes,
    compactEveryNTurns: config.context.compactEveryNTurns ?? 0,
    provider,
    model: modelOverride ?? provider.model ?? "default",
    userInstructionsPath: undefined,
  });

  let sessionTrusted = false;

  const approvals: import("../runtime/approvals.js").ApprovalContext = {
    mode: "ask",
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
    model: modelOverride ?? provider.model,
    workspace: process.cwd(),
    tools: allTools,
    approvals,
    mode: config.runtime.mode,
    maxTokensPerSession: config.runtime.maxTokensPerSession,
    maxTokensPerTurn: config.runtime.maxTokensPerTurn,
    contextManager,
    extensionDispatch,
    bashConcurrency: config.runtime.bashConcurrency,
    checkpointingEnabled: interactive || Boolean(config.runtime.checkpointing),
  });

  mcpManager.onToolsChanged = () => {
    runtime.setTools([
      ...builtInTools,
      ...extensionTools,
      ...createMcpTools(mcpManager),
    ]);
  };

  void extensionDispatch("session_start", {
    type: "session_start",
    reason: "startup",
  });

  if (oneShot || !interactive) {
    // non-interactive / one-shot path
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      if (useTools) {
        await mcpManager.syncTools();
        runtime.setTools([
          ...builtInTools,
          ...extensionTools,
          ...createMcpTools(mcpManager),
        ]);
      }
      const result = await runtime.runAgentTurn(
        oneShot || " ",
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
      if (jsonMode)
        process.stderr.write(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
      else
        process.stderr.write(
          `atom-lite: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      process.exit(1);
    } finally {
      await mcpManager.close().catch(() => {});
      process.off("SIGINT", onSigint);
    }
    return;
  }

  // ---- Interactive TUI (first-class) ----
  const {
    TuiAltScreen,
    Text,
    Input,
    Editor,
    Container,
    Spacer,
    ScrollView,
    VStack,
    Loader,
    Markdown,
    Box,
    visibleWidth,
  } = await import("@earendil-works/pi-tui");

  const mouseEnabled = shouldEnableMouse({
    interactive,
    configured: config.ui.mouse,
    stdoutIsTTY: process.stdout.isTTY === true,
  });
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: mouseEnabled,
  });
  const mouseCapture = createMouseCapture((data) => terminal.write(data));

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
  const streamText = new StreamText(
    transcript,
    200,
    200,
    markdownThemeFor(theme),
  );

  function headerLabel(): string {
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    let displayPath = cwd;
    if (home && cwd.startsWith(home))
      displayPath = "~" + cwd.slice(home.length);
    let branch = "";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (branch === "HEAD") {
        branch = execSync("git rev-parse --short HEAD", {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
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
  let currentMode: "plan" | "yolo" = config.runtime.mode;
  statusBar.setParts({
    left: `${provider.id}/${(provider as any).model ?? "default"}`,
    tokens: "tokens: ?",
    effort: "effort: medium",
    mode: currentMode,
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
  const { CombinedAutocompleteProvider } =
    await import("@earendil-works/pi-tui");
  const { DefaultSkillRegistry, skillCacheSignature } =
    await import("../skills/registry.js");
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

  const collectExtensionCommands = () => {
    const out: any[] = [];
    for (const loaded of extensionLoader.list()) {
      for (const command of loaded.registries?.commands?.values?.() ?? []) {
        out.push(command);
      }
    }
    return out;
  };

  let commandRegistry = createCommandRegistry({
    skills: skillReg.list(),
    extensionCommands: collectExtensionCommands(),
  });
  let registrySkillSignature = skillSignature;
  function refreshCommandRegistry(): void {
    const sig = skillCacheSignature(process.cwd());
    if (sig === registrySkillSignature) return;
    commandRegistry = createCommandRegistry({
      skills: cachedSkillRegistry().list(),
      extensionCommands: collectExtensionCommands(),
    });
    registrySkillSignature = sig;
    input.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        commandRegistry.autocomplete() as any,
        process.cwd(),
        fdPath,
      ),
    );
  }
  const fdPath = (() => {
    for (const bin of ["fd", "fdfind"]) {
      try {
        const found = execSync(`command -v ${bin}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (found) return found;
      } catch {
        // ignore
      }
    }
    return null;
  })();
  input.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      commandRegistry.autocomplete() as any,
      process.cwd(),
      fdPath,
    ),
  );

  // Skills should autocomplete (fill the input) rather than execute immediately
  // when selected from the autocomplete list; Enter on a typed command still
  // runs them. Convert a confirming Enter into a Tab completion for skills.
  const originalHandleInput = input.handleInput.bind(input);
  input.handleInput = (data: string) => {
    try {
      if (
        (data === "\r" || data === "\n") &&
        (input as any).autocompleteState &&
        (input as any).autocompleteList
      ) {
        const selected = (input as any).autocompleteList.getSelectedItem?.();
        const name = selected?.value ?? selected?.name ?? selected?.label;
        const cmd = name
          ? commandRegistry.get(String(name).replace(/^\//, ""))
          : undefined;
        if (cmd?.bareInvokable) {
          originalHandleInput("\t");
          return;
        }
      }
    } catch {
      // Fall through to default handling on any introspection failure.
    }
    originalHandleInput(data);
  };

  const jumpToBottomLabel = "↓ bottom";
  const jumpToBottomView = {
    render(width: number): string[] {
      const label = output.isFollowingEnd
        ? theme.tokens.dim(jumpToBottomLabel)
        : theme.tokens.accent(jumpToBottomLabel);
      const pad = Math.max(0, width - visibleWidth(jumpToBottomLabel));
      return [" ".repeat(pad) + label];
    },
    invalidate(): void {},
  };

  const root = new VStack([]);
  // Keep fixed chrome (spacer, input, jump-to-bottom, status, header, dropdown)
  // from being collapsed when the transcript grows; only the output region may
  // shrink.
  root.addChild(output, { grow: 1, shrink: 1, minSize: 0 });
  root.addChild(new Spacer(1), { grow: 0, shrink: 0, minSize: 1 });
  root.addChild(input, { grow: 0, shrink: 0 });
  root.addChild(jumpToBottomView, { grow: 0, shrink: 0, minSize: 1 });
  root.addChild(statusBar, { grow: 0, shrink: 0 });
  // folder:branch info below the status line, dimmed
  root.addChild(header, { grow: 0, shrink: 0 });
  const dropdownContainer = new Container();
  root.addChild(dropdownContainer, { grow: 0, shrink: 0 });
  tui.setLayoutRoot(root);

  function jumpToBottomRow(): number {
    const width = terminal.columns;
    const outputHeight = Math.max(
      1,
      output.viewportHeight || output.render(width).length,
    );
    const inputHeight = Math.max(1, input.render(width).length);
    return outputHeight + 1 + inputHeight;
  }
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

  class ThinkingBlock {
    buffer = "";
    render(width: number): string[] {
      const lines: string[] = [theme.tokens.dim("💭 thinking")];
      const sep = theme.tokens.dim("│ ");
      const contentWidth = Math.max(1, width - 2);
      const logicalLines =
        this.buffer.length > 0 ? this.buffer.split("\\n") : [""];
      for (const logical of logicalLines) {
        const wrapped = wrapTextWithAnsi(logical, contentWidth);
        if (wrapped.length === 0) {
          lines.push(sep);
        } else {
          for (const part of wrapped) lines.push(sep + theme.tokens.dim(part));
        }
      }
      return lines;
    }
    invalidate(): void {}
  }

  let thinkingText: ThinkingBlock | null = null;
  let thinkingBuffer = "";
  let showThinking = config.ui.showThinking;
  let expandTools = false;
  let uiModalOpen = false;
  const inputHistory: string[] = [];
  let historyIndex = -1;
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

  function appendLine(
    text: string,
    style: (value: string) => string = theme.tokens.text,
  ): void {
    if (thinkingText) {
      thinkingText = null;
      thinkingBuffer = "";
    }
    streamText.finalize();
    transcript.add(new Text(style(text)));
    tui.requestRender();
  }

  function appendDelta(delta: string): void {
    streamText.append(delta);
    tui.requestRender();
  }

  /** Review project-local extensions once per project decision. */
  function maybeReviewProjectTrust(): void {
    if (uiModalOpen) return;
    const pending = extensionLoader
      .discover()
      .filter(
        (entry) =>
          entry.source === "project" &&
          !entry.trusted &&
          entry.skipReason === "project is not trusted",
      );
    if (pending.length === 0) return;

    uiModalOpen = true;
    closeOverlay();
    dropdownContainer.clear();
    const prompt = new ProjectTrustPrompt(
      pending.map((entry) => ({
        id: entry.id,
        entryPath: entry.entryPath,
        version: entry.manifest?.version,
        capabilities: entry.manifest?.capabilities ?? [],
      })),
      process.cwd(),
      (decision) => {
        uiModalOpen = false;
        dropdownContainer.clear();
        tui.setFocus(input);
        if (decision === "approve") {
          trustProject(process.cwd());
          appendLine("approved project extensions");
        } else {
          denyProject(process.cwd());
          appendLine("denied project extensions");
        }
        void extensionLoader
          .loadAll()
          .then(() => {
            runtime.setTools([
              ...builtInTools,
              ...collectExtensionTools(extensionLoader),
              ...createMcpTools(mcpManager),
            ]);
            appendLine(
              `extensions: ${extensionLoader.list().length} processed (see /extensions)`,
            );
            tui.requestRender();
          })
          .catch((error) => {
            appendLine(
              `extensions: reload failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      },
    );
    dropdownContainer.addChild(prompt);
    tui.setFocus(prompt);
    tui.requestRender();
  }

  function thinkingBody(): string {
    return thinkingBuffer
      .split("\n")
      .map((line) => theme.tokens.dim(`│ ${line}`))
      .join("\n");
  }

  function finalizeText(): void {
    streamText.finalize();
  }

  let activeTurnController: AbortController | null = null;
  let shellMode = false;
  const messageQueue: string[] = [];
  const steeringQueue: string[] = [];
  runtime.setSteeringQueue(steeringQueue);

  /** Run one interactive turn while keeping the status bar's activity fresh. */
  async function runTurn(prompt: string): Promise<void> {
    activity.start("formulating");
    const controller = new AbortController();
    activeTurnController = controller;
    try {
      if (useTools) {
        await mcpManager.syncTools();
        runtime.setTools([
          ...builtInTools,
          ...extensionTools,
          ...createMcpTools(mcpManager),
        ]);
      }
      const turnResult = await runtime.runAgentTurn(
        prompt,
        session,
        controller.signal,
      );
      if (turnResult === "TOKEN_BUDGET_REACHED") {
        appendLine("token budget reached; stopping", theme.tokens.warning);
        tui.requestRender();
      }
    } catch (err) {
      if (err instanceof Error && err.message === "USER_CANCELLED") {
        appendLine("cancelled");
      } else {
        appendLine(
          `atom-lite: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      activeTurnController = null;
      activity.stop();
      if (messageQueue.length > 0) {
        const next = messageQueue.shift()!;
        appendLine(`> ${next}`, theme.tokens.user);
        void runTurn(next);
      }
    }
  }

  /** Run a shell command directly (shell mode / `!` prefix). */
  async function runShellCommand(command: string): Promise<void> {
    const shell = defaultShell();
    const flag = process.platform === "win32" ? "/c" : "-c";
    const start = Date.now();
    const cap = 30000;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (target: "out" | "err", chunk: Buffer) => {
      const s = chunk.toString("utf8");
      let accepted = s;
      if (target === "out") {
        if (stdout.length + s.length > cap) {
          truncated = true;
          accepted = s.slice(0, Math.max(0, cap - stdout.length));
          stdout += accepted;
        } else {
          stdout += s;
        }
      } else {
        if (stderr.length + s.length > cap) {
          truncated = true;
          accepted = s.slice(0, Math.max(0, cap - stderr.length));
          stderr += accepted;
        } else {
          stderr += s;
        }
      }
      if (accepted) {
        tui.requestRender();
      }
    };
    try {
      const child = spawn(shell, [flag, command], {
        cwd: process.cwd(),
        env: process.env,
        detached: process.platform !== "win32",
      });
      child.stdout?.on("data", (c: Buffer) => append("out", c));
      child.stderr?.on("data", (c: Buffer) => append("err", c));
      const exit = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) => {
        const timer = setTimeout(() => {
          terminateProcessTree(child, "SIGTERM");
          setTimeout(
            () => terminateProcessTree(child, "SIGKILL"),
            1000,
          ).unref();
          resolve({ code: null, signal: "SIGTERM" });
        }, 120000);
        timer.unref();
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ code: null, signal: null });
          stderr = `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
        });
      });
      const parts: string[] = [];
      parts.push(`exit_code: ${exit.code ?? "null"}`);
      if (exit.signal) parts.push(`signal: ${exit.signal}`);
      if (truncated) parts.push("OUTPUT_TRUNCATED");
      parts.push(`duration_ms: ${Date.now() - start}`);
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      const content = parts.join("\n");
      appendLine(
        content,
        exit.code === 0 && !exit.signal && !stderr
          ? theme.tokens.success
          : theme.tokens.error,
      );
    } catch (err) {
      appendLine(
        `shell error: ${err instanceof Error ? err.message : String(err)}`,
        theme.tokens.error,
      );
    }
  }

  function updateStatus(): void {
    const usage = runtime.getContextUsage();
    statusBar.setParts({
      left: `${provider.id}/${currentModelLabel()}`,
      tokens: `tokens: ${formatContextUsage(usage.used, usage.window)}`,
      effort: `effort: ${effortLevel}`,
      mode: currentMode,
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
    const pcfg = profileConfig(profile);
    const configuredWindow = pcfg?.contextWindow;
    const staticWindow = knownContextWindow(model);
    // Prefer the largest known value so a stale 256K guess never masks a 1M
    // model: config (if explicit) is a floor, static table and live metadata
    // can only raise it.
    const initialWindow =
      typeof configuredWindow === "number" && configuredWindow > 0
        ? Math.max(configuredWindow, staticWindow ?? 0) || configuredWindow
        : staticWindow;
    runtime.setContextWindow(initialWindow);
    // Config override for vision takes precedence over provider metadata.
    if (typeof pcfg?.supportsVision === "boolean") {
      runtime.setSupportsVision(pcfg.supportsVision);
    } else {
      const guessed = knownVisionModel(model);
      if (typeof guessed === "boolean") runtime.setSupportsVision(guessed);
    }
    updateStatus();

    const getModelInfo = (provider as any).getModelInfo;
    if (typeof getModelInfo !== "function") return;
    void Promise.resolve()
      .then(() => getModelInfo.call(provider))
      .then((info: any) => {
        if (provider.id !== profile || currentModelLabel() !== model) return;
        const resolved = info?.contextWindow;
        if (typeof resolved === "number" && resolved > 0) {
          const current = runtime.getContextUsage().window;
          const floor =
            typeof configuredWindow === "number" && configuredWindow > 0
              ? configuredWindow
              : (staticWindow ?? 0);
          // Live metadata may only raise the window; never downgrade below
          // the configured/static floor.
          if (current === undefined || resolved > (current ?? 0)) {
            runtime.setContextWindow(Math.max(floor, resolved));
            updateStatus();
          }
        }
        if (
          typeof pcfg?.supportsVision !== "boolean" &&
          typeof info?.supportsVision === "boolean"
        ) {
          runtime.setSupportsVision(info.supportsVision);
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
  for (const loaded of extensionLoader.list()) {
    for (const [name, provider] of loaded.registries?.providers ?? new Map()) {
      const cfg = (provider as any)?.config ?? {};
      const models = Array.isArray(cfg.models)
        ? cfg.models.map((m: any) => m.id ?? m.name).filter(Boolean)
        : [];
      if (models.length > 0) {
        modelCache.set(name, { models, at: Date.now() });
      }
    }
  }

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

  function refreshModelCache(names: string[], onUpdate: () => void): void {
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
      appendLine(
        `warning: could not persist model choice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    modelByProvider.set(profile, model);
    modelOverride = model;
    provider = createProvider(config, profile, model);
    runtime.switchModel(provider, model);
    refreshContextWindow();
    appendLine(`switched to ${profile}/${model}`);
    void extensionDispatch("config_change", {
      type: "config_change",
      scope: "model",
      provider: profile,
      model,
    });
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
      picker.setStatus(
        `loading live models from ${stale.length} provider${stale.length === 1 ? "" : "s"}…`,
      );
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
      session.appendEvent({
        type: "provider_selected",
        provider: preset.id,
        model: chosen,
      });
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

  function promptForApiKey(
    preset: ProviderPreset,
    existingKey: string | null,
  ): void {
    uiModalOpen = true;
    closeOverlay();
    dropdownContainer.clear();
    const wrapper = new Container();
    wrapper.addChild(new Text(theme.tokens.accent(`${preset.label} API key`)));
    if (preset.keyUrl)
      wrapper.addChild(
        new Text(theme.tokens.dim(`create one: ${preset.keyUrl}`)),
      );
    if (existingKey)
      wrapper.addChild(
        new Text(
          theme.tokens.dim("a key is already saved — press Enter to keep it"),
        ),
      );
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
            appendLine(
              `could not activate ${preset.label}: ${err instanceof Error ? err.message : String(err)}`,
            );
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
        appendLine(
          `warning: could not verify ${preset.label} key (${probe.error ?? "network error"}); saved anyway`,
        );
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
        appendLine(
          `could not activate ${preset.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
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
    if (extra) {
      appendLine(`> ${extra}`, theme.tokens.user);
    }
    session.appendMessage({ role: "system", content });
    if (typeof (session as any).appendEvent === "function") {
      session.appendEvent({ type: "skill_loaded", name });
    }
    try {
      await (session as any).flush?.();
    } catch {
      // Best effort.
    }
    appendLine(`Loaded skill: ${name}`, theme.tokens.dim);
    if (extra) {
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
    newSession: () => {
      session = store.create(process.cwd(), provider.id);
      sessionTrusted = false;
      session.messages.length = 0;
      content.clear();
      runtime.resetContextUsage();
      updateStatus();
      tui.requestRender();
    },
    updateStatus,
    runDoctor,
    runMcp,
    runCompact,
    runExport,
    openModelPicker,
    openProviderPicker,
    openEffortPicker,
    openThemePicker,
    openSessionsPicker,
    openKeybindings: () => {
      const path = defaultUserConfigPath();
      appendLine(`keybindings config: ${path}`);
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (editor) {
        try {
          spawn(editor, [path], { stdio: "inherit" });
        } catch (error) {
          appendLine(
            `could not open editor: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (process.platform === "linux") {
        try {
          spawn("xdg-open", [path], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } catch {
          // Best effort.
        }
      }
      tui.requestRender();
    },
    shortcutsText: () => {
      const kb = (config as any).keybindings ?? {};
      return Object.entries(kb)
        .map(([action, key]) => `${action}: ${key ?? "(disabled)"}`)
        .join("\n");
    },
    searchSessions: searchSessionsInStore,
    renameSession,
    listExtensions: () => {
      const report = extensionLoader.report();
      if (report.length === 0) return "No extensions discovered.";
      return report
        .map((ext) => {
          const origin = ext.origin
            ? `${ext.source}:${ext.origin}`
            : ext.source;
          const version = ext.version ? `v${ext.version}` : "-";
          const counts = `${ext.toolCount} tools / ${ext.commandCount} commands`;
          const error = ext.error ? `\t${ext.error}` : "";
          return `${ext.id}\t${origin}\t${version}\t${ext.status}\t${counts}\t${ext.entryPath}${error}`;
        })
        .join("\n");
    },
    extensionDoctor: () => extensionLoader.doctor(),
    reloadExtensions,
    switchModel: switchModelTarget,
    startProviderSetup,
    setEffort: setEffortTarget,
    toggleThinking: () => {
      showThinking = !showThinking;
      return showThinking;
    },
    setTheme: setThemeTarget,
    listSkills: () =>
      cachedSkillRegistry()
        .list()
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
    loadSkill,
    runTurn,
    requestExit: () => {
      extensionLoader.notifySessionEnd();
      void shutdownLsp().finally(() => {
        void mcpManager.close().finally(() => {
          tui.stop();
          process.exit(0);
        });
      });
    },
  };

  function restoreTranscript(next: any): void {
    streamText.finalize();
    transcript.reset();
    // Drop stale references so toggles only affect the resumed transcript.
    toolBoxes.length = 0;
    banner.setTheme(theme);
    transcript.add(banner);
    transcript.add(new Spacer(1));

    const messages = Array.isArray(next?.messages) ? next.messages : [];

    // Index tool results by their call id so each restored ToolBox can carry
    // its output and render as the same collapsible block used live.
    const resultsByCallId = new Map<string, any>();
    for (const message of messages) {
      if (message?.role === "tool" && message.toolCallId) {
        resultsByCallId.set(String(message.toolCallId), message);
      }
    }
    const renderedToolCallIds = new Set<string>();

    const textOf = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part: any) =>
            part?.type === "text" ? String(part.text ?? "") : "",
          )
          .join("");
      }
      return "";
    };

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "system") continue;

      if (message.role === "user") {
        const text = textOf(message.content).trim();
        if (text) {
          transcript.add(new Text(theme.tokens.user(`> ${text}`)));
        }
        continue;
      }

      if (message.role === "assistant") {
        const text = textOf(message.content).trim();
        if (text) {
          transcript.add(new Markdown(text, 0, 0, markdownThemeFor(theme)));
        }
        for (const call of message.toolCalls ?? []) {
          const box = new ToolBox({
            id: String(call?.id ?? ""),
            name: String(call?.name ?? ""),
            args: call?.arguments ?? {},
          });
          box.setExpanded(expandTools);
          const result = resultsByCallId.get(String(call?.id ?? ""));
          if (result) {
            box.setResult(String(result.content ?? ""), {
              isError: result.isError === true,
              diff: Array.isArray(result.diff) ? result.diff : undefined,
            });
            renderedToolCallIds.add(String(call?.id ?? ""));
          }
          transcript.add(box);
          toolBoxes.push(box);
        }
        continue;
      }

      if (message.role === "tool") {
        if (renderedToolCallIds.has(String(message.toolCallId ?? ""))) continue;
        const text = String(message.content ?? "").trim();
        if (text) {
          transcript.add(
            new Text(theme.tokens.text(`[${message.name}] ${text}`)),
          );
        }
        continue;
      }
    }

    tui.requestRender();
  }

  function resumeSession(id: string): void {
    const next = store.resume(id);
    if (!next) {
      appendLine(`could not resume session: ${id}`);
      return;
    }
    const previous = session.id;
    session = next;
    session.appendEvent({ type: "session_resumed", from: previous });
    restoreTranscript(next);
    const title = sessionTitleFromEvents(next.events);
    appendLine(
      `resumed session ${session.id}: ${title} (${session.messages.length} messages)`,
    );
    const notice = providerSwitchNotice(
      { provider: provider.id, model: currentModelLabel() },
      sessionSelectionFromEvents(next.events),
    );
    if (notice) appendLine(notice);
    updateStatus();
    tui.requestRender();
  }

  function renameSession(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) {
      appendLine("usage: /session rename <title>");
      return;
    }
    session.appendEvent({ type: "session_renamed", title: trimmed });
    appendLine(`session renamed: ${trimmed}`);
    tui.requestRender();
  }

  function searchSessionsInStore(query: string): void {
    const matches = searchSessions(store.list(), query);
    if (matches.length === 0) {
      appendLine(`no sessions match “${query}”`);
      return;
    }
    appendLine(formatSessionSearch(matches));
  }

  function openSessionsPicker(initialScope: "workspace" | "all"): void {
    uiModalOpen = true;
    let scope = initialScope;
    const buildItems = (): PickerItem[] => {
      const summaries =
        scope === "all" ? store.list() : store.list(process.cwd());
      const toggle: PickerItem = {
        value: "__scope__",
        label:
          scope === "all" ? "Show this workspace only" : "Show all workspaces",
        description: `scope: ${scope === "all" ? "all workspaces" : process.cwd()}`,
      };
      return [
        toggle,
        ...summaries.map((summary: any) => ({
          value: `session:${summary.id}`,
          label: summary.title ?? summary.id,
          description: `${summary.updatedAt ?? "unknown"} · ${summary.provider} · ${summary.messageCount ?? 0} messages · ${summary.workspace}`,
        })),
      ];
    };

    let picker: ReturnType<typeof openSearchablePicker>;
    picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Resume session",
      theme,
      items: buildItems(),
      closeOnSelect: false,
      onSelect: (item) => {
        if (item.value === "__scope__") {
          scope = scope === "all" ? "workspace" : "all";
          picker.updateItems(buildItems());
          picker.setStatus(
            scope === "all"
              ? "showing all workspaces"
              : "showing this workspace",
          );
          return;
        }
        picker.close();
        uiModalOpen = false;
        resumeSession(item.value.slice("session:".length));
      },
      onCancel: () => {
        uiModalOpen = false;
        appendLine("cancelled");
      },
      restoreFocus: () => tui.setFocus(input),
    });
    closeActiveOverlay = picker.close;
    picker.setStatus(
      scope === "all" ? "showing all workspaces" : "showing this workspace",
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
        label: summary.title ?? summary.id,
        description: `${summary.updatedAt ?? "unknown"} · ${summary.provider} · ${summary.messageCount ?? 0} messages`,
        category: "Sessions",
        keywords: [summary.provider, summary.workspace],
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
    transcript.invalidate();
    tui.requestRender();
  }

  async function reloadExtensions(): Promise<void> {
    const previous = extensionLoader.list();
    // Emit session_shutdown and extension_unload before unloading.
    for (const loaded of previous) {
      const handlers = loaded.registries?.handlers?.get?.(
        "session_shutdown" as any,
      );
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(
              { type: "session_shutdown", reason: "reload" },
              (loaded.context ?? {}) as any,
            );
          } catch (error) {
            appendLine(
              `extension shutdown error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    await extensionLoader.unloadAll();
    try {
      await extensionLoader.loadAll();
    } catch (error) {
      appendLine(
        `extensions: reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      tui.requestRender();
      return;
    }
    // Remove previously bridged providers, then re-bridge.
    for (const name of extensionProviderNames) {
      delete (config.providers as Record<string, any>)[name];
      modelCache.delete(name);
    }
    extensionProviderNames.clear();
    for (const loaded of extensionLoader.list()) {
      for (const [name, provider] of loaded.registries?.providers ??
        new Map()) {
        const cfg = (provider as any)?.config ?? {};
        const firstModel =
          Array.isArray(cfg.models) && cfg.models.length > 0
            ? (cfg.models[0].id ?? cfg.models[0].name ?? "default")
            : "default";
        const apiKey = resolveExtensionApiKey(cfg.apiKey);
        const headers = {
          ...(cfg.headers as Record<string, string> | undefined),
        };
        if (cfg.authHeader && apiKey) {
          setHeader(headers, "Authorization", `Bearer ${apiKey}`);
        }
        (config.providers as Record<string, any>)[name] = {
          type: "openai-compatible",
          baseUrl: cfg.baseUrl,
          model: firstModel,
          apiKey: apiKey ?? null,
          apiKeyEnv: null,
          headers,
          contextWindow: cfg.models?.[0]?.contextWindow,
        };
        extensionProviderNames.add(name);
        const models = Array.isArray(cfg.models)
          ? cfg.models.map((m: any) => m.id ?? m.name).filter(Boolean)
          : [];
        if (models.length > 0) modelCache.set(name, { models, at: Date.now() });
      }
    }

    // Re-apply extension tools.
    try {
      await mcpManager.syncTools();
    } catch {
      // ignore
    }
    runtime.setTools([
      ...builtInTools,
      ...collectExtensionTools(extensionLoader),
      ...createMcpTools(mcpManager),
    ]);
    // Emit session_start with reason reload.
    for (const loaded of extensionLoader.list()) {
      const handlers = loaded.registries?.handlers?.get?.(
        "session_start" as any,
      );
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(
              { type: "session_start", reason: "reload" },
              (loaded.context ?? {}) as any,
            );
          } catch (error) {
            appendLine(
              `extension start error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    refreshCommandRegistry();
    appendLine(
      `extensions: ${extensionLoader.list().length} reloaded (see /extensions)`,
    );
    void extensionDispatch("config_change", {
      type: "config_change",
      scope: "extensions",
    });
    tui.requestRender();
  }

  // Wire interactive extension UI callbacks now that the TUI exists.
  extensionUICallbacks.notify = (
    message: string,
    type?: "info" | "warning" | "error",
  ) => {
    const style =
      type === "error"
        ? theme.tokens.error
        : type === "warning"
          ? theme.tokens.warning
          : theme.tokens.accent;
    appendLine(`${style(`[ext]`)} ${message}`);
  };
  extensionUICallbacks.requestRender = () => tui.requestRender();
  extensionUICallbacks.getToolsExpanded = () => expandTools;
  extensionUICallbacks.setToolsExpanded = (expanded: boolean) => {
    if (expandTools !== expanded) toggleTools();
  };

  extensionUICallbacks.select = (title, options, opts) =>
    new Promise((resolve) => {
      if (!interactive) {
        resolve(undefined);
        return;
      }
      uiModalOpen = true;
      closeOverlay();
      dropdownContainer.clear();
      const items = (options ?? []).map((option: any, index: number) => ({
        value: String(index),
        label: String(option),
      }));
      const picker = openSearchablePicker({
        tui,
        container: dropdownContainer,
        title: String(title ?? "Select"),
        theme,
        items,
        closeOnSelect: true,
        onSelect: (item) => {
          uiModalOpen = false;
          dropdownContainer.clear();
          tui.setFocus(input);
          resolve(options?.[Number(item.value)]);
        },
        onCancel: () => {
          uiModalOpen = false;
          dropdownContainer.clear();
          tui.setFocus(input);
          resolve(undefined);
        },
        restoreFocus: () => tui.setFocus(input),
      });
      closeActiveOverlay = picker.close;
      tui.requestRender();
    });

  extensionUICallbacks.confirm = (title, message, opts) =>
    new Promise((resolve) => {
      if (!interactive) {
        resolve(false);
        return;
      }
      uiModalOpen = true;
      closeOverlay();
      dropdownContainer.clear();
      const items = [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ];
      const picker = openSearchablePicker({
        tui,
        container: dropdownContainer,
        title: `${title ?? "Confirm"}: ${message ?? ""}`,
        theme,
        items,
        closeOnSelect: true,
        onSelect: (item) => {
          uiModalOpen = false;
          dropdownContainer.clear();
          tui.setFocus(input);
          resolve(item.value === "yes");
        },
        onCancel: () => {
          uiModalOpen = false;
          dropdownContainer.clear();
          tui.setFocus(input);
          resolve(false);
        },
        restoreFocus: () => tui.setFocus(input),
      });
      closeActiveOverlay = picker.close;
      tui.requestRender();
    });

  extensionUICallbacks.input = (title, placeholder, opts) =>
    new Promise((resolve) => {
      if (!interactive) {
        resolve(undefined);
        return;
      }
      uiModalOpen = true;
      closeOverlay();
      dropdownContainer.clear();
      const wrapper = new Container();
      wrapper.addChild(new Text(theme.tokens.accent(String(title ?? "Input"))));
      const editor = new Editor(tui, editorTheme, {});
      editor.onSubmit = (value: string) => {
        uiModalOpen = false;
        dropdownContainer.clear();
        tui.setFocus(input);
        resolve(value.trim());
      };
      wrapper.addChild(editor);
      dropdownContainer.addChild(wrapper);
      tui.setFocus(editor);
      tui.requestRender();
    });

  function toggleToolBoxAtScreenRow(screenY: number): boolean {
    const width = terminal.columns;
    const outputHeight = Math.max(
      1,
      output.viewportHeight || output.render(width).length,
    );
    if (screenY < 0 || screenY >= outputHeight) return false;

    const children = content.children as any[];
    const contentBlocks = children.map((child, index) => ({
      id: `content:${index}`,
      height: child.render(width).length,
    }));
    const total = contentBlocks.reduce((sum, block) => sum + block.height, 0);
    const viewportTop = Math.max(0, total - outputHeight);
    const inner = blockAtLine(contentBlocks, viewportTop + screenY);
    if (!inner) return false;
    const child = children[Number(inner.id.slice("content:".length))];
    if (!(child instanceof ToolBox)) return false;
    child.toggleExpanded();
    transcript.invalidate();
    return true;
  }

  tui.addInputListener((data: string) => {
    const event = parseSgrMouse(data);
    if (!event) return undefined;
    // Let the alt-screen TUI own wheel scrolling; only intercept clicks.
    if (event.type === "wheel") return undefined;
    if (!mouseEnabled) return { consume: true };
    if (
      event.type === "press" &&
      event.button === "left" &&
      event.y === jumpToBottomRow()
    ) {
      output.scrollToEnd();
      tui.requestRender();
      return { consume: true };
    }
    handleMouseEvent(event, {
      isModalOpen: () => uiModalOpen,
      scrollBy: (lines) => output.scrollBy(lines),
      focusInput: () => tui.setFocus(input),
      toggleToolBox: (screenY) => toggleToolBoxAtScreenRow(screenY),
      requestRender: () => tui.requestRender(),
    });
    return { consume: true };
  });

  tui.addInputListener((data: string) => {
    // Releases and repeats must not toggle modal shortcuts twice.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;

    const keybindings = ((config as any).keybindings ?? {}) as Record<
      string,
      string | null
    >;
    const matchesBinding = (action: string): boolean => {
      const key = keybindings[action];
      return typeof key === "string" && matchesKey(data, key as any);
    };

    if (!uiModalOpen) {
      if (matchesBinding("jumpBottom")) {
        output.scrollToEnd();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("newSession")) {
        commandContext.newSession();
        appendLine("started new session");
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("searchSessions")) {
        openSessionsPicker("workspace");
        return { consume: true };
      }
      if (matchesBinding("scrollUp")) {
        output.scrollBy(-5);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("scrollDown")) {
        output.scrollBy(5);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("toggleThinking")) {
        showThinking = !showThinking;
        appendLine(`thinking display: ${showThinking ? "shown" : "hidden"}`);
        tui.requestRender();
        return { consume: true };
      }
    }

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
    // Tab toggles plan/yolo mode.
    if (matchesKey(data, Key.tab) && !uiModalOpen) {
      currentMode = currentMode === "plan" ? "yolo" : "plan";
      runtime.setMode(currentMode);
      updateStatus();
      appendLine(`mode: ${currentMode}`, theme.tokens.dim);
      tui.requestRender();
      return { consume: true };
    }
    // Escape cancels the active turn, or exits shell mode.
    if (matchesKey(data, Key.escape) && !uiModalOpen) {
      if (activeTurnController) {
        activeTurnController.abort();
        return { consume: true };
      }
      if (shellMode) {
        shellMode = false;
        appendLine("shell mode: off", theme.tokens.dim);
        tui.requestRender();
        return { consume: true };
      }
    }
    return undefined;
  });

  runtime["onEvent"] = (e: any) => {
    if (e.type === "thinking_delta") {
      activity.setPhase("thinking");
      if (!showThinking) return;
      if (!thinkingText) {
        thinkingText = new ThinkingBlock();
        transcript.add(thinkingText);
        thinkingBuffer = "";
      }
      thinkingBuffer += e.text;
      thinkingText.buffer = thinkingBuffer;
      transcript.invalidate();
      tui.requestRender();
    } else if (e.type === "assistant_delta") {
      activity.setPhase("working");
      if (thinkingText) {
        transcript.invalidate();
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
    } else if (e.type === "assistant_text") {
      activity.setPhase("working");
      if (thinkingText) {
        transcript.invalidate();
        thinkingText = null;
        thinkingBuffer = "";
      }
      appendDelta(e.text);
      finalizeText();
    } else if (e.type === "context_usage") {
      updateStatus();
    } else if (e.type === "background_task_complete") {
      appendLine(
        `background task ${e.id}: ${e.status} (exit ${e.exitCode ?? "null"})`,
        theme.tokens.dim,
      );
      tui.requestRender();
    } else if (e.type === "checkpoint_created") {
      appendLine(`checkpoint ${e.id} created`, theme.tokens.dim);
      tui.requestRender();
    } else if (e.type === "checkpoint_failed") {
      appendLine(`checkpoint failed: ${e.reason}`, theme.tokens.warning);
      tui.requestRender();
    } else if (e.type === "checkpoint_unavailable") {
      appendLine(
        `checkpoint unavailable: ${e.reason ?? "not a git repository"}`,
        theme.tokens.warning,
      );
      tui.requestRender();
    } else if (e.type === "task_ledger_open") {
      appendLine(
        `task ledger: ${e.pending} open item(s) remain`,
        theme.tokens.warning,
      );
      tui.requestRender();
    } else if (e.type === "budget_warning") {
      appendLine(
        `budget warning (${e.scope}): ${e.used}/${e.limit} tokens`,
        theme.tokens.warning,
      );
      tui.requestRender();
    } else if (e.type === "model_switched") {
      appendLine(`switched model to ${e.provider}/${e.model}`);
      if (typeof (session as any).appendEvent === "function") {
        session.appendEvent({
          type: "model_switched",
          provider: e.provider,
          model: e.model,
        });
      }
      updateStatus();
    } else if (e.type === "tool_call") {
      if (thinkingText) {
        transcript.invalidate();
        thinkingText = null;
        thinkingBuffer = "";
      }
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
        transcript.invalidate();
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
      if (thinkingText) {
        transcript.invalidate();
        thinkingText = null;
        thinkingBuffer = "";
      }
      finalizeText();
      activity.stop();
    }
  };

  async function runDoctor(): Promise<string> {
    const lines: string[] = ["Doctor:"];
    try {
      loadConfig();
      lines.push("  config: ok");
    } catch (e) {
      lines.push(
        `  config: FAIL ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
    lines.push(...formatMcpDoctor(mcpManager.status()));
    return lines.join("\n");
  }

  async function runMcp(args: string): Promise<void> {
    const trimmed = (args ?? "").trim();
    if (trimmed === "reconnect" || trimmed.startsWith("reconnect ")) {
      const server = trimmed.slice("reconnect".length).trim();
      try {
        if (server) await mcpManager.reconnect(server);
        else await mcpManager.reconnect();
      } catch (e) {
        appendLine(
          `mcp reconnect failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      if (useTools) {
        await mcpManager.syncTools();
        runtime.setTools([
          ...builtInTools,
          ...extensionTools,
          ...createMcpTools(mcpManager),
        ]);
      }
      appendLine(formatMcpStatus(mcpManager.status()));
      return;
    }
    if (trimmed) {
      appendLine("usage: /mcp [reconnect [server]]");
      return;
    }
    appendLine(formatMcpStatus(mcpManager.status()));
  }

  async function runExport(args: string): Promise<void> {
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    let format = "md";
    let force = false;
    let redact = true;
    const positional: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--format") {
        format = tokens[++i] ?? format;
      } else if (t.startsWith("--format=")) {
        format = t.slice("--format=".length);
      } else if (t === "--force") {
        force = true;
      } else if (t === "--no-redact") {
        redact = false;
      } else {
        positional.push(t);
      }
    }
    const isJson = format === "json";
    const ext = isJson ? "json" : "md";
    const outPath = positional[0] || `${session.id}.${ext}`;

    if (existsSync(outPath) && !force) {
      appendLine(`export refused: ${outPath} already exists (use --force)`);
      return;
    }

    if (!redact) {
      appendLine("warning: redaction disabled; secrets may be written to disk");
    }

    const secretPatterns = [
      /sk-[A-Za-z0-9_-]{8,}/g,
      /ghp_[A-Za-z0-9]{20,}/g,
      /gho_[A-Za-z0-9]{20,}/g,
      /github_pat_[A-Za-z0-9_]{20,}/g,
      /AKIA[0-9A-Z]{16}/g,
      /xox[baprs]-[A-Za-z0-9-]{10,}/g,
      /Bearer\s+[A-Za-z0-9._-]+/g,
    ];
    const redactText = (value: string): string => {
      if (!redact) return value;
      let out = value;
      for (const pattern of secretPatterns) {
        out = out.replace(pattern, "[REDACTED]");
      }
      return out;
    };

    const messageText = (message: any): string => {
      const content = message?.content;
      if (Array.isArray(content)) {
        return content
          .map((p: any) => (p?.type === "text" ? p.text : ""))
          .join("");
      }
      return typeof content === "string" ? content : "";
    };

    if (isJson) {
      const events =
        typeof (session as any).events !== "undefined"
          ? (session as any).events
          : [];
      const payload = {
        version: 1,
        session: {
          id: session.id,
          workspace: session.workspace,
          provider: session.provider,
          messageCount: session.messages.length,
        },
        messages: session.messages,
        events,
      };
      let json = JSON.stringify(payload, null, 2);
      if (redact) json = redactText(json);
      writeFileSync(outPath, json + "\n", "utf8");
      appendLine(`exported session to ${outPath}`);
      return;
    }

    const lines: string[] = [];
    lines.push(`# Session ${session.id}`);
    lines.push("");
    lines.push(`- Workspace: ${session.workspace}`);
    lines.push(`- Provider: ${session.provider}`);
    lines.push(`- Messages: ${session.messages.length}`);
    lines.push(`- Exported: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## Table of contents");
    lines.push("");
    let turn = 0;
    for (const message of session.messages) {
      if (message.role === "user") {
        turn++;
        const snippet = redactText(messageText(message))
          .split("\\n")[0]
          .slice(0, 80);
        lines.push(`${turn}. ${snippet || "(empty)"}`);
      }
    }
    lines.push("");
    lines.push("## Transcript");
    lines.push("");
    for (const message of session.messages) {
      if (message.role === "user") {
        lines.push("### User");
        lines.push("");
        lines.push(redactText(messageText(message)));
        lines.push("");
      } else if (message.role === "assistant") {
        lines.push("### Assistant");
        lines.push("");
        const text = redactText(messageText(message));
        if (text.trim()) lines.push(text);
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
          lines.push("");
          lines.push("Tool calls:");
          for (const call of message.toolCalls) {
            lines.push(
              `- \`${call.name}\` ${JSON.stringify(call.arguments ?? {})}`,
            );
          }
        }
        lines.push("");
      } else if (message.role === "tool") {
        lines.push(`### Tool result: ${message.name}`);
        lines.push("");
        const content = redactText(String(message.content ?? ""));
        const truncated =
          content.length > 4000
            ? content.slice(0, 4000) + "\\n… (truncated)"
            : content;
        lines.push("```");
        lines.push(truncated);
        lines.push("```");
        lines.push("");
      }
    }
    writeFileSync(outPath, lines.join("\\n"), "utf8");
    appendLine(`exported session to ${outPath}`);
  }

  async function runCompact(args: string): Promise<void> {
    const focus = (args ?? "").trim();
    if (session.messages.length <= 6) {
      appendLine("nothing to compact");
      return;
    }
    const summary = await runtime.compactSession(session, focus || undefined);
    if (!summary) {
      appendLine("nothing to compact");
      return;
    }
    appendLine(`compacted: ${summary.slice(0, 200)}`);
  }

  input.onSubmit = async (value: string) => {
    const trimmed = value.trim();
    input.setText("");
    if (trimmed) {
      try {
        (input as any).addToHistory?.(trimmed);
      } catch {
        // Best effort; history is non-critical.
      }
    }
    if (!trimmed) {
      tui.requestRender();
      return;
    }

    // Shell mode: every line is a shell command. `!` alone (or as first char)
    // enters shell mode; Escape exits it.
    if (shellMode) {
      const cmd = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;
      appendLine(`$ ${cmd}`, theme.tokens.user);
      await runShellCommand(cmd);
      tui.requestRender();
      return;
    }

    // `!` as first character enters shell mode.
    if (trimmed === "!" || trimmed.startsWith("! ")) {
      shellMode = true;
      const rest = trimmed.slice(1).trim();
      appendLine("shell mode: on (Escape to exit)", theme.tokens.dim);
      if (rest) {
        appendLine(`$ ${rest}`, theme.tokens.user);
        await runShellCommand(rest);
      }
      tui.requestRender();
      return;
    }

    refreshCommandRegistry();
    if (trimmed === "/steer" || trimmed.startsWith("/steer ")) {
      const text = trimmed.slice("/steer".length).trim();
      if (!text) {
        appendLine("usage: /steer <message>");
        tui.requestRender();
        return;
      }
      if (activeTurnController) {
        steeringQueue.push(text);
        appendLine(`steering: ${text}`, theme.tokens.dim);
      } else {
        appendLine(`> ${text}`, theme.tokens.user);
        await runTurn(text);
      }
      tui.requestRender();
      return;
    }
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
      await commandRegistry.dispatch(
        `/${bare} ${trimmed.slice(bare.length)}`,
        commandContext,
      );
      return;
    }

    if (activeTurnController) {
      messageQueue.push(trimmed);
      appendLine(`queued: ${trimmed}`, theme.tokens.dim);
      tui.requestRender();
      return;
    }
    appendLine(`> ${trimmed}`, theme.tokens.user);
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
              appendLine(
                "trusted this session: outside-workspace operations will run without approval",
                theme.tokens.dim,
              );
            }
            resolve(decision);
          });
          dropdownContainer.addChild(prompt);
          tui.setFocus(prompt);
          tui.requestRender();
        })
    : undefined;

  process.on("SIGTERM", () => {
    void mcpManager.close().finally(() => {
      tui.stop();
      process.exit(0);
    });
  });

  tui.start();
  maybeReviewProjectTrust();
  if (mouseEnabled) {
    process.once("exit", () => mouseCapture.disable());
    if (process.platform !== "win32") {
      process.on("SIGTSTP", () => {
        mouseCapture.disable();
        process.kill(process.pid, "SIGSTOP");
      });
      process.on("SIGCONT", () => {
        mouseCapture.enable();
        tui.requestRender();
      });
    }
  }

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
