import { loadConfig } from "../config/load.js";
import { resolveCompactionPolicy } from "../context/compaction-policy.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/system-prompt.js";
import {
  defaultAgentDir,
  defaultUserConfigPath,
  defaultUsageLedgerPath,
  userConfigDir,
} from "../config/paths.js";
import { saveProviderSelection, saveTheme } from "../config/write.js";
import { resolveApiKey, saveApiKey } from "../config/credentials.js";
import {
  DefaultSkillRegistry,
  skillCacheSignature,
} from "../skills/registry.js";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { defaultShell, terminateProcessTree } from "../security/process.js";
import {
  BackgroundTaskManager,
  createTaskStore,
} from "../runtime/background-tasks.js";
import { redactSecrets } from "../security/redaction.js";
import { openSearchablePicker, type PickerItem } from "./picker.js";
import { openCommandPalette, type PaletteItem } from "./palette.js";
import {
  bareCommandName,
  createCommandRegistry,
  type CommandContext,
} from "./commands.js";
import {
  resolveTheme,
  resolveThemeName,
  themeLabel,
  themeNames,
  type Theme,
  markdownThemeFor,
} from "./theme.js";
import { SecretInput } from "./secret-input.js";
import { StatusLine } from "./status-line.js";
import { Footer } from "./footer.js";
import { GoalPanel } from "./goal-panel.js";
import { purgeOrphanCheckpoints } from "../runtime/legacy-checkpoint-purge.js";
import { Activity } from "./activity.js";
import { formatTurnStats } from "./turn-stats.js";
import { ToolBox } from "./tool-box.js";
import { UserBox } from "./user-box.js";
import { ApprovalPrompt, type ApprovalDecision } from "./approval-prompt.js";
import { QuestionPromptView } from "./question-prompt.js";
import { Banner } from "./banner.js";
import {
  formatContextUsage,
  formatTokens,
  knownContextWindow,
  knownVisionModel,
} from "../providers/context-window.js";
import { resolveModelCapabilities } from "../providers/model-catalog.js";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "../providers/thinking-levels.js";
import { startRemoteCatalogRefresh } from "../providers/remote-catalog.js";
import { getUsageBreakdown } from "../usage/ledger.js";
import {
  STREAM_LIVE_LINES,
  STREAM_SEAL_BATCH,
  StreamText,
} from "./stream-text.js";
import { ThinkingBlock } from "./thinking-block.js";
import { initLsp, shutdownLsp } from "../lsp/index.js";
import { Transcript } from "./transcript.js";
import { AgentRuntime } from "../agent/loop.js";
import { FileUsageLedger } from "../usage/ledger.js";
import { DefaultAgentRegistry } from "../agents/registry.js";
import { resolveConfiguredAgent } from "../agents/selection.js";
import {
  JsonlSessionStore,
  InMemorySession,
  type Session,
} from "../sessions/store.js";
import { SessionLockError } from "../sessions/lock.js";
import { randomUUID } from "node:crypto";
import {
  ExtensionLoader,
  type StagedExtensionSet,
} from "../extensions/loader.js";
import { createDefaultExtensionUI, DialogBoundary } from "../extensions/ui.js";
import type { ExtensionUICallbacks } from "../extensions/ui.js";
import { resolveModelTools } from "../extensions/tool-adapter.js";
import { describeScopes } from "../extensions/manifest.js";
import type { AtomEvent } from "../extensions/types.js";
import {
  denyProject,
  isProjectDenied,
  isProjectTrusted,
  trustProject,
  untrustProject,
} from "../extensions/trust.js";
import { ProjectTrustPrompt } from "./trust-prompt.js";
import {
  formatSessionList,
  formatSessionSearch,
  searchSessions,
  sessionTitleFromEvents,
} from "../sessions/search.js";
import {
  providerSwitchNotice,
  sessionSelectionFromEvents,
} from "../sessions/history.js";
import {
  blockAtScreenRow,
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
  goalTool,
  questionTool,
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
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";
import { installEditorKeybindings } from "./editor-keybindings.js";
import { createMainRow } from "./main-layout.js";
import type { QuestionContext, QuestionOutcome } from "../runtime/questions.js";

/**
 * Interactive exit path: notify extensions before tearing the host down.
 * Kept separate from the TUI so the ordering is observable with fakes.
 */
export async function closeInteractiveSession(
  loader: Pick<ExtensionLoader, "notifySessionEnd">,
  shutdown: () => Promise<void>,
  exit: (code: number) => void,
): Promise<void> {
  await loader.notifySessionEnd().catch(() => {});
  await shutdown();
  exit(0);
}

export async function run(args: string[]): Promise<void> {
  // Harness subcommand: dispatch before any provider, session store or TUI is
  // created so a fixture test needs no network or user configuration.
  if (args[0] === "extension" && args[1] === "test") {
    const fixture = args[2];
    if (!fixture) {
      process.stderr.write(
        "atom-lite: extension test requires a fixture path\n",
      );
      process.exitCode = 1;
      return;
    }
    const { runExtensionTest } = await import("../extensions/harness.js");
    const result = await runExtensionTest(fixture);
    for (const line of result.output) process.stdout.write(`${line}\n`);
    if (!result.passed) process.exitCode = 1;
    return;
  }

  installEditorKeybindings();
  let providerOverride: string | undefined;
  let modelOverride: string | undefined;
  let jsonMode = false;
  let showVersion = false;
  let sessionOverride: string | undefined;
  let themeOverride: string | undefined;
  let noColor = false;
  let listSessions = false;
  let searchSessionsQuery: string | undefined;
  let serveMode = false;
  let servePort: number | undefined;
  let shareMode = false;
  let showQr = true;
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
    else if (a === "--version") showVersion = true;
    else if (a === "--continue") positional.push("__continue__");
    else if (a === "--session") sessionOverride = args[++i];
    else if (a === "--list-sessions") listSessions = true;
    else if (a === "--search-sessions") searchSessionsQuery = args[++i] ?? "";
    else if (a === "--theme") themeOverride = args[++i];
    else if (a === "--no-color") noColor = true;
    else if (a === "--no-tools") positional.push("__notools__");
    else if (a === "--serve") {
      serveMode = true;
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        servePort = parseInt(next, 10);
        i++;
      }
    } else if (a === "--share") {
      shareMode = true;
      serveMode = true;
    } else if (a === "--no-qr") {
      showQr = false;
    } else if (a === "--help") {
      process.stdout.write(
        "atom-lite [task] [--provider NAME] [--model MODEL] [--continue] [--session ID] [--list-sessions] [--search-sessions QUERY] [--no-tools] [--json] [--theme NAME] [--no-color] [-e PATH] [--serve [PORT]] [--share] [--no-qr] [--version] [--help]\n" +
          "atom-lite extension test <path>  run an extension fixture without a provider\n",
      );
      return;
    } else if (a.startsWith("--")) {
      process.stderr.write(`atom-lite: ignoring unknown option ${a}\n`);
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
  startRemoteCatalogRefresh();
  initLsp(config, process.cwd());
  const shutdownLspOnce = () => {
    void shutdownLsp();
  };
  process.on("exit", shutdownLspOnce);
  // Modes that own a long-running loop (serve) install a hook so shutdown
  // waits for their final events before the process exits.
  let shutdownHook: (() => Promise<void>) | undefined;
  const signalShutdown = () => {
    void shutdownLsp()
      .finally(() => Promise.resolve(shutdownHook?.()))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", signalShutdown);
  process.on("SIGTERM", signalShutdown);
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
  let effortLevel = "medium";
  let currentModelCapabilities: import("../types.js").ModelInfo | undefined;
  let currentMode: "plan" | "yolo" = config.runtime.mode;
  let tuiReady = false;
  const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  const modelCache = new Map<string, { models: string[]; at: number }>();
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
        goalTool,
        questionTool,
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

  let agentReg = new DefaultAgentRegistry(process.cwd(), {
    projectTrusted: isProjectTrusted(process.cwd()),
  });
  const configuredAgent = resolveConfiguredAgent(
    agentReg,
    config.runtime.agent,
  );
  if (configuredAgent.warning && !interactive) {
    process.stderr.write(`atom-lite: ${configuredAgent.warning}\n`);
  }

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
  const sessionsEnabled = config.sessions.enabled !== false;
  let session: Session;
  if (!sessionsEnabled) {
    if (sessionOverride || positional.includes("__continue__")) {
      process.stderr.write(
        "atom-lite: sessions are disabled in config; starting an ephemeral session\n",
      );
    }
    session = new InMemorySession(randomUUID(), process.cwd(), provider.id);
  } else {
    if (config.sessions.retentionDays) {
      store.pruneOldSessions(config.sessions.retentionDays);
    }
    try {
      session = sessionOverride
        ? (store.resume(sessionOverride) ??
          store.create(process.cwd(), provider.id))
        : positional.includes("__continue__")
          ? (store.resumeLatest(process.cwd()) ??
            store.create(process.cwd(), provider.id))
          : store.create(process.cwd(), provider.id);
    } catch (err) {
      if (err instanceof SessionLockError) {
        process.stderr.write(`atom-lite: ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  // Automatic checkpoints were removed (ADR 0018); sweep up orphaned capture
  // directories left by terminated workers. Cheap readdir; runs every start
  // so the huge leftovers from the checkpoint era get collected.
  try {
    purgeOrphanCheckpoints();
  } catch {
    // best effort; never block startup on legacy cleanup
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
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
  /** Current turn's signal, read by `pi.exec` so turn abort cancels children. */
  let activeExtensionSignal: AbortSignal | undefined;
  const extensionLoader = new ExtensionLoader({
    cliPaths: extensionPaths,
    cwd: process.cwd(),
    agentDir: defaultAgentDir(),
    userDir: join(userConfigDir(), "extensions"),
    projectDir: process.cwd(),
    hasUI: interactive,
    session,
    uiFactory: (registries, ctx) =>
      createDefaultExtensionUI(registries, ctx, extensionUICallbacks),
    onLifecycleEvent: (event) => {
      if (event.type !== "extension_error") return;
      const where = event.method ? ` ${event.method}` : "";
      process.stderr.write(
        `atom-lite: extension ${event.extensionId}${where}: ${event.error ?? "error"}\n`,
      );
    },
    host: {
      signal: () => activeExtensionSignal,
      onToolOutput: (stream, text) => {
        try {
          (session as any)?.appendEvent?.({
            type: "tool_output",
            toolCallId: "pi.exec",
            name: "pi.exec",
            stream,
            text,
          });
        } catch {
          // Observability must not break a running extension.
        }
      },
    },
    onProviderUnregistered: (name) => {
      // The bridged provider lives only in memory. Drop it from every host
      // selection source in the same call as the API unregister.
      delete (config.providers as Record<string, unknown>)[name];
      modelCache.delete(name);
      extensionProviderNames.delete(name);
      if (provider.id === name) {
        const fallback = availableProviderNames(config).find(
          (candidate) => candidate !== name,
        );
        if (fallback) {
          void switchToModel(
            fallback,
            String(profileConfig(fallback)?.model ?? "default"),
          );
        }
      }
    },
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
  const untrustedAgents = agentReg.untrusted();
  if (!interactive && untrustedAgents.length > 0) {
    process.stderr.write(
      `atom-lite: skipping ${untrustedAgents.length} untrusted project agent(s); run interactively to review\n`,
    );
  }
  try {
    await extensionLoader.loadAll();
  } catch (error) {
    // A top-level load failure is not an extension-scoped error; record it so
    // it still appears in doctor and tell the user on stderr.
    extensionLoader.reportTopLevelError(error, "loadAll");
  }
  // Remove any previously bridged extension providers before re-bridging.
  for (const name of extensionProviderNames) {
    delete (config.providers as Record<string, unknown>)[name];
  }
  extensionProviderNames.clear();

  // Bridge Pi-style extension providers into Atom-lite's config so they
  // appear in /provider, /model, and the command palette.
  for (const loaded of extensionLoader.loadedExtensions()) {
    for (const [name, provider] of loaded.registries?.providers ?? new Map()) {
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
      (config.providers as Record<string, unknown>)[name] = {
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

  // Resolve the model-visible tool set from current loader/MCP state at every
  // refresh point. No cached snapshot: a runtime mutation or reload must be
  // visible on the next turn, and --no-tools must suppress every tool source.
  const currentTools = (includeMcp: boolean) =>
    resolveModelTools({
      builtInTools,
      loader: extensionLoader,
      mcpTools: includeMcp ? createMcpTools(mcpManager) : [],
      useTools,
    });
  // The loader owns handler dispatch; the CLI delegates so every host event
  // goes through the same awaited, error-contained seam.
  const extensionDispatch = (event: AtomEvent, payload: any) =>
    extensionLoader.dispatchEvent(event, payload);

  /**
   * Persist a model switch with the ephemeral flag for bridged providers and
   * announce it. Shared by the web switch and /model so neither can forget the
   * flag or the config_change dispatch.
   */
  async function commitModelSelection(
    profile: string,
    model: string,
    reportPersistError: (message: string) => void,
  ): Promise<void> {
    try {
      saveProviderSelection(
        profile,
        { model },
        {
          defaultProvider: profile,
          ephemeral: extensionProviderNames.has(profile),
        },
      );
    } catch (err) {
      reportPersistError(err instanceof Error ? err.message : String(err));
    }
    await extensionDispatch("config_change", {
      type: "config_change",
      scope: "model",
      provider: profile,
      model,
    });
  }

  const usageLedger = config.usage.ledgerEnabled
    ? new FileUsageLedger(
        config.usage.ledgerPath ?? defaultUsageLedgerPath(),
        config.usage.prices,
      )
    : undefined;

  const providerProfile =
    (config.providers as Record<string, any>)[initialProfile] ?? {};
  const selectedModel = modelOverride ?? provider.model ?? "default";
  const compactionStrategy = resolveCompactionPolicy(
    {
      global: config.context.compactionStrategy,
      provider: providerProfile.compactionStrategy,
      models: providerProfile.models,
    },
    selectedModel,
    typeof (provider as any).compact === "function",
  );

  const contextManager = new ContextManager({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    compactionStrategy,
    maxInputTokens: config.context.maxInputTokens ?? null,
    reserveOutputTokens: config.context.reserveOutputTokens,
    compactAtPercent: config.context.compactAtPercent,
    maxProjectInstructionBytes: config.context.maxProjectInstructionBytes,
    compactEveryNTurns: config.context.compactEveryNTurns ?? 0,
    compactionModel: config.context.compactionModel ?? null,
    keepTokens: config.context.keepTokens,
    buffer: config.context.buffer,
    background: config.context.background,
    cacheMode: config.context.cacheMode,
    repoMap: config.context.repoMap,
    provider,
    model: modelOverride ?? provider.model ?? "default",
    userInstructionsPath: undefined,
    usageLedger,
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
    resetTrust: () => {
      sessionTrusted = false;
    },
    nonInteractive: !interactive,
  };

  const questions: QuestionContext = {
    // Installed below once the TUI exists.
    handler: undefined,
    nonInteractive: !interactive,
  };

  const backgroundTasks = new BackgroundTaskManager();
  backgroundTasks.setStore(createTaskStore(process.cwd()));

  const runtime = new AgentRuntime({
    provider,
    model: modelOverride ?? provider.model,
    workspace: process.cwd(),
    backgroundTasks,
    tools: currentTools(false),
    approvals,
    questions,
    persona: configuredAgent.persona,
    mode: config.runtime.mode,
    web: config.web,
    maxTokensPerSession: config.runtime.maxTokensPerSession,
    maxTokensPerTurn: config.runtime.maxTokensPerTurn,
    codeMode: config.runtime.codeMode,
    usageLedger,
    contextManager,
    warming: config.context.warming,
    background: config.context.background,
    extensionDispatch,
    bashConcurrency: config.runtime.bashConcurrency,
    limits: {
      maxParallelToolCalls: config.runtime.maxParallelToolCalls,
      maxToolOutputBytes: config.runtime.maxToolOutputBytes,
      maxBashTimeMs: config.runtime.maxBashTimeMs,
    },
  });

  mcpManager.onToolsChanged = () => {
    runtime.setTools(currentTools(true));
  };

  await extensionDispatch("session_start", {
    type: "session_start",
    reason: "startup",
  });

  if (serveMode) {
    // Web surface: the same runtime, tools, session, and approvals, driven
    // from a browser instead of the terminal.
    if (oneShot) {
      process.stderr.write(
        "atom-lite: a task argument is ignored in --serve mode; type it in the browser\n",
      );
    }
    // Picker values encode provider and model in one string; keep that split
    // in one place so the initial list and the live refresh read it alike.
    const parseModelKey = (
      key: string,
    ): { provider: string; model: string } => {
      const [provider, model] = key.split("\u0000");
      return { provider, model };
    };
    const webModels = () =>
      buildModelItems().map((item) => {
        const { provider, model } = parseModelKey(item.value);
        return {
          provider,
          model,
          label: item.description ?? providerLabel(provider),
        };
      });
    const webSwitchModel = async (profile: string, model: string) => {
      const pcfg = ensureProfile(profile);
      if (!pcfg) return { error: `unknown provider: ${profile}` };
      pcfg.model = model;
      config.defaultProvider = profile;
      modelByProvider.set(profile, model);
      modelOverride = model;
      provider = createProvider(config, profile, model);
      runtime.switchModel(provider, model);
      try {
        refreshContextWindow();
      } catch (err) {
        // The live switch already succeeded; metadata refresh is best effort.
        process.stderr.write(
          `atom-lite: could not refresh model metadata: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      await commitModelSelection(profile, model, (message) => {
        // A read-only config must not block the live switch.
        process.stderr.write(
          `atom-lite: could not persist model choice: ${message}\n`,
        );
      });
      return { provider: profile, model, models: webModels() };
    };
    const lanAddress = shareMode
      ? (await import("../web/lan.js")).findLanAddress()
      : undefined;
    if (shareMode && !lanAddress) {
      process.stderr.write("atom-lite: no LAN IPv4 address found\n");
      process.exitCode = 1;
      return;
    }
    const webAgentList = (registry: DefaultAgentRegistry) =>
      registry.primary().map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: agent.source,
      }));
    const webAgents = (root: string) =>
      webAgentList(
        new DefaultAgentRegistry(root, {
          projectTrusted: isProjectTrusted(root),
        }),
      );
    const webSwitchAgent = (name: string, root: string) => {
      const registry = new DefaultAgentRegistry(root, {
        projectTrusted: isProjectTrusted(root),
      });
      const persona = registry.get(name);
      if (!persona || persona.mode !== "primary") {
        return { error: `unknown agent: ${name}` };
      }
      runtime.setPersona(persona);
      return { agent: persona.name, agents: webAgentList(registry) };
    };

    const { startWebServer, webThemeFor } = await import("../web/server.js");
    const server = await startWebServer({
      runtime,
      session,
      approvals,
      questions,
      providerName: provider.id,
      model: provider.model ?? "",
      models: webModels(),
      switchModel: webSwitchModel,
      agent: runtime.getPersona()?.name ?? null,
      agents: webAgents,
      switchAgent: webSwitchAgent,
      refreshModels: async () => {
        const names = availableProviderNames(config);
        if (!names.includes(provider.id) && profileConfig(provider.id)) {
          names.unshift(provider.id);
        }
        const batches = await Promise.all(
          names.map(async (name) => {
            let pcfg = profileConfig(name);
            if (!pcfg) {
              const preset = getPreset(name);
              if (!preset) return [] as string[];
              pcfg = materializeProviderConfig(preset);
              (config.providers as Record<string, unknown>)[name] = pcfg;
            }
            const configured = pcfg?.model ? [String(pcfg.model)] : [];
            const live = await listModelsForProvider(config, name, 8000);
            return [...new Set([...configured, ...live])].map(
              (model) => `${name}\u0000${model}`,
            );
          }),
        );
        const seen = new Set<string>();
        const found: { provider: string; model: string; label?: string }[] = [];
        for (const key of batches.flat()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const { provider, model } = parseModelKey(key);
          found.push({
            provider,
            model,
            label: providerLabel(provider),
          });
        }
        return found;
      },
      skills: (() => {
        let cachedRoot = "";
        let cachedSignature = "";
        let registry: InstanceType<typeof DefaultSkillRegistry> | undefined;
        return (root: string) => {
          const signature = skillCacheSignature(root);
          if (
            !registry ||
            root !== cachedRoot ||
            signature !== cachedSignature
          ) {
            registry = new DefaultSkillRegistry(root);
            cachedRoot = root;
            cachedSignature = signature;
          }
          return registry.list().map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          }));
        };
      })(),
      mcpStatus: () => mcpManager.status(),
      setMcpEnabled: async (name, enabled) => {
        await mcpManager.setEnabled(name, enabled);
        runtime.setTools(currentTools(true));
        return mcpManager.status();
      },
      mode: currentMode,
      effort: effortLevel,
      setMode: (mode) => {
        currentMode = mode;
        runtime.setMode(mode);
      },
      setEffort: (effort) => {
        effortLevel = effort;
        runtime.setEffort(effort);
      },
      store: sessionsEnabled ? store : undefined,
      workspace: process.cwd(),
      theme: webThemeFor(
        resolveThemeName(themeOverride ?? config.ui.theme, {
          noColor,
          env: process.env,
        }),
      ),
      port: servePort ?? 7317,
      openBrowser: !shareMode,
      bindHost: shareMode ? "0.0.0.0" : undefined,
      allowedHost: lanAddress,
    });

    let closing = false;
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void server.close().finally(() => resolveStop());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    const finished = (async () => {
      await stopped;
      await extensionLoader.notifySessionEnd();
    })();
    shutdownHook = async () => {
      shutdown();
      await finished;
    };

    if (shareMode) {
      const shareUrl = `http://${lanAddress}:${server.port}/?token=${encodeURIComponent(server.token)}`;
      process.stdout.write(`atom-lite: local web UI at ${server.url}\n`);
      process.stdout.write(`atom-lite: shared UI at ${shareUrl}\n`);
      if (showQr) {
        try {
          const { default: QRCode } = await import("qrcode");
          const qr = await QRCode.toString(shareUrl, {
            type: "terminal",
            small: true,
          });
          process.stdout.write(`${qr}\n`);
        } catch {
          process.stdout.write(
            "atom-lite: QR rendering unavailable; use the URL above\n",
          );
        }
      }
    } else {
      process.stdout.write(`atom-lite: web UI at ${server.url}\n`);
    }
    await finished;
    await mcpManager.close().catch(() => {});
    return;
  }

  if (oneShot || !interactive) {
    // non-interactive / one-shot path
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    activeExtensionSignal = controller.signal;
    try {
      if (useTools) {
        await mcpManager.syncTools();
        runtime.setTools(currentTools(true));
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
      process.exitCode = 1;
    } finally {
      activeExtensionSignal = undefined;
      // Every terminal mode emits session_end, including --json and one-shot.
      await extensionLoader.notifySessionEnd();
      await mcpManager.close().catch(() => {});
      process.off("SIGINT", onSigint);
    }
    return;
  }

  // ---- Interactive TUI (first-class) ----
  const {
    TuiAltScreen,
    Text,
    Editor,
    Container,
    Spacer,
    ScrollView,
    VStack,
    Markdown,
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

  runtime.setEffort(effortLevel);

  let themeName = themeOverride ?? config.ui.theme;
  if (noColor) themeName = "ansi";
  let terminalScheme: "dark" | "light" | undefined;
  let theme: Theme = resolveTheme(themeName, {
    noColor,
    env: process.env,
    scheme: terminalScheme,
  });

  runtime.restoreSessionState(session);
  const goalPanel = new GoalPanel(theme);
  goalPanel.setState(runtime.getGoal(), runtime.getTodos());

  const transcript = new Transcript(theme);
  const banner = new Banner(theme);
  transcript.add(banner);
  transcript.add(new Spacer(1));
  const content = transcript.container;
  const output = new ScrollView(content, {
    follow: "end",
    primary: true,
    // Transient scrollbar: appears on scroll activity when the transcript
    // overflows the viewport, hides after a short idle delay. "always" would
    // reserve a content column (see ScrollView.getContentWidth), shifting
    // wrap widths and the tool-box click hit-test metrics.
    scrollbar: "auto",
    scrollbarTrackStyle: () => theme.tokens.dim("│"),
    scrollbarThumbStyle: (text) => theme.tokens.accent(text),
  });
  const streamText = new StreamText(
    transcript,
    STREAM_LIVE_LINES,
    STREAM_SEAL_BATCH,
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
  const statusBar = new StatusLine(theme);
  const footer = new Footer(theme);
  const activity = new Activity({ theme, onChange: () => updateStatus() });
  tuiReady = true;
  statusBar.setParts({
    left: `${provider.id}/${provider.model ?? "default"}`,
    cwd: headerLabel(),
    effort: "effort: medium",
    mode: currentMode,
    agent: runtime.getPersona()?.name ?? "default",
    activity: activity.text(),
    openTodos: runtime.openTodoCount(),
  });
  footer.setParts({ autoCompact: true });

  const selectListTheme = {
    selectedPrefix: (s: string) => theme.tokens.accent(s),
    selectedText: (s: string) => theme.tokens.selection(s),
    description: (s: string) => theme.tokens.dim(s),
    scrollInfo: (s: string) => theme.tokens.dim(s),
    noMatch: (s: string) => theme.tokens.dim(s),
  };
  let currentBorderColor = (s: string) => theme.tokens.border(s);
  const editorTheme = {
    borderColor: (s: string) => currentBorderColor(s),
    selectList: selectListTheme,
  };
  const input = new Editor(tui, editorTheme, {});
  const { CombinedAutocompleteProvider } =
    await import("@earendil-works/pi-tui");
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
    for (const loaded of extensionLoader.loadedExtensions()) {
      for (const command of loaded.registries?.commands?.values?.() ?? []) {
        const run = command.run ?? command.handler;
        out.push({
          ...command,
          extensionContext: loaded.context,
          run: (args: string, ctx: any) =>
            extensionLoader.runBounded(
              { extensionId: loaded.id, method: `command:/${command.name}` },
              () => (typeof run === "function" ? run(args, ctx) : undefined),
              { rethrow: true },
            ),
        });
      }
    }
    return out;
  };

  let commandRegistry = createCommandRegistry({
    skills: skillReg.list(),
    extensionCommands: collectExtensionCommands(),
  });
  let registrySkillSignature = skillSignature;
  function refreshCommandRegistry(force = false): void {
    const sig = skillCacheSignature(process.cwd());
    if (!force && sig === registrySkillSignature) return;
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

  const root = new VStack([]);
  const mainRow = createMainRow(output, goalPanel);
  // Keep fixed chrome (spacer, input, status, header, dropdown)
  // from being collapsed when the transcript grows; only the output region may
  // shrink.
  root.addChild(mainRow, { grow: 1, shrink: 1, minSize: 0 });
  root.addChild(new Spacer(1), { grow: 0, shrink: 0, minSize: 1 });
  const questionDock = new Container();
  root.addChild(questionDock, { grow: 0, shrink: 0, minSize: 0 });
  root.addChild(input, { grow: 0, shrink: 0 });
  root.addChild(statusBar, { grow: 0, shrink: 0 });
  root.addChild(footer, { grow: 0, shrink: 0 });
  const dropdownContainer = new Container();
  root.addChild(dropdownContainer, { grow: 0, shrink: 0 });
  tui.setLayoutRoot(root);

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

  let thinkingText: ThinkingBlock | null = null;
  let showThinking = config.ui.showThinking;
  let expandTools = false;
  let uiModalOpen = false;
  let closeActiveOverlay: (() => void) | undefined;
  const dialogBoundary = new DialogBoundary();
  const toolBoxes: ToolBox[] = [];
  const toolBoxesById = new Map<string, ToolBox>();

  /**
   * Close whichever modal overlay owns the keyboard. Callers that clear the
   * dropdown container directly must use this first, or the overlay's input
   * listener would keep consuming keys after it disappears from the screen.
   */
  function closeOverlay(): void {
    // Reject any dialog promise still waiting on this overlay so an extension
    // awaiting it cannot hang the turn after teardown.
    dialogBoundary.cancelAll("dialog overlay closed");
    const close = closeActiveOverlay;
    closeActiveOverlay = undefined;
    close?.();
  }

  function appendLine(
    text: string,
    style: (value: string) => string = theme.tokens.text,
  ): void {
    thinkingText = null;
    streamText.finalize();
    transcript.add(new Text(style(text)));
    tui.requestRender();
  }

  function appendDelta(delta: string): void {
    streamText.append(delta);
    tui.requestRender();
  }

  /** Review project-local extensions and agent personas once per decision. */
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
    const untrustedAgents = agentReg.untrusted();
    if (pending.length === 0 && untrustedAgents.length === 0) return;

    const hasAgents = untrustedAgents.length > 0;
    const entries = [
      ...pending.map((entry) => ({
        id: entry.id,
        entryPath: entry.entryPath,
        version: entry.manifest?.version,
        capabilities: entry.manifest?.capabilities ?? [],
        scopes: describeScopes(entry.manifest?.scopes),
      })),
      ...untrustedAgents.map((agent) => ({
        id: `${agent.name} (agent)`,
        entryPath: agent.path,
        capabilities: ["agent persona: system prompt and tool permissions"],
      })),
    ];
    const options = hasAgents
      ? {
          title:
            pending.length > 0
              ? "project agents and extensions need approval"
              : "project agents need approval",
          note: "only approve projects you trust; extensions run with your permissions and agents can change the system prompt and tool permissions",
        }
      : undefined;

    uiModalOpen = true;
    closeOverlay();
    dropdownContainer.clear();
    const prompt = new ProjectTrustPrompt(
      entries,
      process.cwd(),
      (decision) => {
        uiModalOpen = false;
        dropdownContainer.clear();
        tui.setFocus(input);
        if (decision === "approve") {
          trustProject(process.cwd());
          appendLine("approved project files");
        } else {
          denyProject(process.cwd());
          appendLine("denied project files");
        }

        agentReg = new DefaultAgentRegistry(process.cwd(), {
          projectTrusted: isProjectTrusted(process.cwd()),
        });
        const selected = resolveConfiguredAgent(agentReg, config.runtime.agent);
        if (
          selected.persona &&
          runtime.getPersona()?.name !== selected.persona.name
        ) {
          runtime.setPersona(selected.persona);
          appendLine(
            `agent: ${selected.persona.name}${selected.persona.description ? ` — ${selected.persona.description}` : ""}`,
          );
          updateStatus();
        } else if (selected.warning) {
          appendLine(`atom-lite: ${selected.warning}`, theme.tokens.warning);
        }

        // Trust approval changes which extensions discover() sees, so use the
        // same atomic path as /reload instead of a partial load.
        void reloadExtensions();
      },
      options,
    );
    dropdownContainer.addChild(prompt);
    tui.setFocus(prompt);
    tui.requestRender();
  }

  function finalizeText(): void {
    streamText.finalize();
  }

  let activeTurnController: AbortController | null = null;
  let turnStartedAt = 0;
  let turnOutputTokens = 0;
  let turnModelMs = 0;
  let shellMode = false;
  const messageQueue: string[] = [];
  const steeringQueue: string[] = [];
  runtime.setSteeringQueue(steeringQueue);

  /** Run one interactive turn while keeping the status bar's activity fresh. */
  async function runTurn(prompt: string): Promise<void> {
    activity.start("formulating");
    turnStartedAt = Date.now();
    turnOutputTokens = 0;
    turnModelMs = 0;
    const controller = new AbortController();
    activeTurnController = controller;
    activeExtensionSignal = controller.signal;
    try {
      if (useTools) {
        await mcpManager.syncTools();
        runtime.setTools(currentTools(true));
      }
      const turnResult = await runtime.runAgentTurn(
        prompt,
        session,
        controller.signal,
      );
      if (turnResult === "TOKEN_BUDGET_REACHED") {
        appendLine("token budget reached; stopping", theme.tokens.warning);
        tui.requestRender();
      } else if (turnResult === "GOAL_PAUSED") {
        appendLine(
          "goal paused; use /goal resume to continue",
          theme.tokens.warning,
        );
        syncGoalPanel();
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
      activeExtensionSignal = undefined;
      activity.stop();
      if (turnStartedAt > 0) {
        appendLine(
          formatTurnStats(
            Date.now() - turnStartedAt,
            turnOutputTokens,
            turnModelMs,
          ),
          theme.tokens.dim,
        );
        turnStartedAt = 0;
        turnOutputTokens = 0;
        turnModelMs = 0;
      }
      if (messageQueue.length > 0) {
        const next = messageQueue.shift()!;
        transcript.add(new Spacer(1));
        transcript.add(new UserBox(`> ${next}`));
        tui.requestRender();
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
    const cum = runtime.getCumulativeUsage();
    statusBar.setParts({
      left: `${provider.id}/${currentModelLabel()}`,
      cwd: headerLabel(),
      effort: `effort: ${effortLevel}`,
      mode: currentMode,
      agent: runtime.getPersona()?.name ?? "default",
      activity: activity.text(),
      openTodos: runtime.openTodoCount(),
    });
    footer.setParts({
      used: usage.used,
      window: usage.window,
      percent: usage.percent ?? null,
      autoCompact: true,
      cumulativeInput: cum.input,
      cumulativeOutput: cum.output,
      cumulativeCacheRead: cum.cacheRead,
      cumulativeCacheWrite: cum.cacheWrite,
      cumulativeCost: cum.cost,
      cacheHitRate: cum.cacheHitRate,
    });
    tui.requestRender();
  }

  function showUsage(): void {
    const records = usageLedger?.records ?? [];
    const breakdown = getUsageBreakdown(records);
    if (breakdown.length === 0) {
      appendLine("no recorded usage");
      return;
    }
    appendLine("usage by model:");
    for (const e of breakdown) {
      appendLine(
        `  ${e.key}: $${e.cost.toFixed(3)} (${formatTokens(e.tokens)} tokens)`,
      );
    }
  }

  function syncGoalPanel(): void {
    goalPanel.setState(runtime.getGoal(), runtime.getTodos());
    updateStatus();
    tui.requestRender();
  }

  function currentModelLabel(): string {
    return modelOverride ?? provider.model ?? "default";
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
    thinkingText?.setTheme(theme);
    statusBar.setTheme(theme);
    goalPanel.setTheme(theme);
    activity.setTheme(theme);
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
   * Resolve the window from the catalog first. Gateway models the catalog does
   * not know (for example Kilo's routed models) fall back to the provider's own
   * /models metadata, which is authoritative for those model ids.
   */
  async function refreshContextWindow(): Promise<void> {
    const profile = provider.id;
    const model = currentModelLabel();
    const pcfg = profileConfig(profile);
    const override = config.modelOverrides?.[`${profile}/${model}`];
    const resolved = resolveModelCapabilities(profile, model, {
      profileContextWindow:
        typeof pcfg?.contextWindow === "number"
          ? pcfg.contextWindow
          : undefined,
      override: override as any,
    });
    let window = resolved.contextWindow;
    let info: any;
    if (typeof provider.getModelInfo === "function") {
      try {
        info = await provider.getModelInfo.call(provider);
      } catch {
        // keep catalog resolution
      }
    }
    if (
      window === undefined &&
      typeof info?.contextWindow === "number" &&
      info.contextWindow > 0
    ) {
      window = info.contextWindow;
    }
    runtime.setContextWindow(window);
    currentModelCapabilities = resolved;
    if (typeof pcfg?.supportsVision === "boolean") {
      runtime.setSupportsVision(pcfg.supportsVision);
    } else {
      const guessed =
        typeof info?.supportsVision === "boolean"
          ? info.supportsVision
          : knownVisionModel(model);
      if (typeof guessed === "boolean") runtime.setSupportsVision(guessed);
    }
    if (tuiReady) updateStatus();
  }

  function applyModelThinkingDefault(profile: string, model: string): void {
    const key = `${profile}/${model}`;
    const configured = config.modelThinkingLevels?.[key];
    const resolved = resolveModelCapabilities(profile, model, {
      profileContextWindow: profileConfig(profile)?.contextWindow as
        number | undefined,
      override: config.modelOverrides?.[key],
    });
    const supported = getSupportedThinkingLevels(resolved);
    let level: string = configured ?? effortLevel;
    if (!supported.includes(level as any)) {
      level = clampThinkingLevel(resolved, level as any);
    }
    effortLevel = level;
    runtime.setEffort(level);
    runtime.setReasoning(level);
    currentBorderColor =
      level === "high" || level === "xhigh" || level === "max"
        ? (s: string) => theme.tokens.warning(s)
        : level === "off"
          ? (s: string) => theme.tokens.border(s)
          : (s: string) => theme.tokens.accent(s);
    updateStatus();
  }

  // Resolve the initial model's window before the first response.
  refreshContextWindow();
  applyModelThinkingDefault(provider.id, currentModelLabel());

  for (const loaded of extensionLoader.loadedExtensions()) {
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

  function profileConfig(profile: string): Record<string, unknown> | undefined {
    return (config.providers as Record<string, unknown>)[profile] as
      Record<string, unknown> | undefined;
  }

  /** Ensure a preset profile exists in the in-memory config. */
  function ensureProfile(profile: string): Record<string, unknown> | undefined {
    let pcfg = profileConfig(profile);
    if (pcfg) return pcfg;
    const preset = getPreset(profile);
    if (!preset) return undefined;
    pcfg = materializeProviderConfig(preset);
    (config.providers as Record<string, unknown>)[profile] = pcfg;
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
        (config.providers as Record<string, unknown>)[name] = pcfg;
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

  async function switchToModel(profile: string, model: string): Promise<void> {
    const pcfg = ensureProfile(profile);
    if (!pcfg) {
      appendLine(`unknown provider: ${profile}`);
      return;
    }
    pcfg.model = model;
    config.defaultProvider = profile;
    modelByProvider.set(profile, model);
    modelOverride = model;
    provider = createProvider(config, profile, model);
    runtime.switchModel(provider, model);
    refreshContextWindow();
    applyModelThinkingDefault(profile, model);
    await commitModelSelection(profile, model, (message) => {
      appendLine(`warning: could not persist model choice: ${message}`);
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
      void switchToModel(provider.id, rest);
      return;
    }
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const profile = rest.slice(0, slash);
      const model = rest.slice(slash + 1);
      if (profileConfig(profile) || getPreset(profile)) {
        void switchToModel(profile, model);
        return;
      }
    }
    if (profileConfig(rest) || getPreset(rest)) {
      ensureProfile(rest);
      const pcfg = profileConfig(rest);
      void switchToModel(
        rest,
        String(pcfg?.model ?? modelOverride ?? "default"),
      );
      return;
    }
    void switchToModel(provider.id, rest);
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
        void switchToModel(profile, model);
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
    (config.providers as Record<string, unknown>)[preset.id] = pcfg;
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
    if (typeof session.appendEvent === "function") {
      session.appendEvent({
        type: "provider_selected",
        provider: preset.id,
        model: chosen,
      });
    }
    refreshContextWindow();
    appendLine(`provider: ${preset.label} (${preset.id}) · model: ${chosen}`);
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

  const THINKING_DESCRIPTIONS: Record<string, string> = {
    off: "No reasoning",
    minimal: "~1k tokens",
    low: "~2k tokens",
    medium: "~8k tokens",
    high: "~16k tokens",
    xhigh: "~32k tokens",
    max: "Maximum reasoning",
  };

  function supportedThinkingLevels(): string[] {
    if (!currentModelCapabilities)
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    return getSupportedThinkingLevels(currentModelCapabilities);
  }

  function openThinkingPicker(): void {
    uiModalOpen = true;
    const levels = supportedThinkingLevels();
    const items = levels.map((level) => ({
      value: level,
      label: level,
      description: THINKING_DESCRIPTIONS[level] ?? "",
    }));
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select thinking level",
      theme,
      items,
      maxVisible: Math.max(3, levels.length),
      onSelect: (item) => {
        uiModalOpen = false;
        setThinkingTarget(item.value);
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

  function setThinkingTarget(level: string): void {
    const supported = supportedThinkingLevels();
    const resolved = currentModelCapabilities
      ? clampThinkingLevel(currentModelCapabilities, level as any)
      : level;
    const effective = supported.includes(resolved)
      ? resolved
      : (supported[0] ?? "off");
    if (currentModelCapabilities && !currentModelCapabilities.reasoning) {
      appendLine("Current model does not support thinking");
      return;
    }
    effortLevel = effective;
    runtime.setEffort(effective);
    runtime.setReasoning(effective);
    currentBorderColor =
      effective === "high" || effective === "xhigh" || effective === "max"
        ? (s: string) => theme.tokens.warning(s)
        : effective === "off"
          ? (s: string) => theme.tokens.border(s)
          : (s: string) => theme.tokens.accent(s);
    // persist the chosen level into the per-model default:

    const mt = config.modelThinkingLevels as Record<string, string>;
    mt[`${provider.id}/${currentModelLabel()}`] = effective;
    updateStatus();
    appendLine(`thinking set to ${effortLevel}`);
  }

  // Back-compat alias
  function openEffortPicker(): void {
    openThinkingPicker();
  }
  function setEffortTarget(level: "low" | "medium" | "high"): void {
    setThinkingTarget(level);
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

  function agentPickerItems(): PickerItem[] {
    const active = runtime.getPersona()?.name;
    return agentReg.primary().map((agent) => ({
      value: agent.name,
      label: `${agent.name === active ? "* " : "  "}${agent.name}`,
      description: agent.description,
    }));
  }

  function openAgentPicker(): void {
    agentReg = new DefaultAgentRegistry(process.cwd(), {
      projectTrusted: isProjectTrusted(process.cwd()),
    });
    const activeName = runtime.getPersona()?.name;
    if (activeName && !agentReg.get(activeName)) {
      runtime.setPersona(undefined);
      updateStatus();
    }
    uiModalOpen = true;
    const picker = openSearchablePicker({
      tui,
      container: dropdownContainer,
      title: "Select agent",
      theme,
      items: agentPickerItems(),
      maxVisible: 15,
      initialValue: runtime.getPersona()?.name,
      onSelect: (item) => {
        uiModalOpen = false;
        const persona = agentReg.get(item.value);
        if (!persona) {
          appendLine(`unknown agent: ${item.value}`);
          return;
        }
        runtime.setPersona(persona);
        appendLine(
          `agent: ${persona.name}${persona.description ? ` — ${persona.description}` : ""}`,
        );
        updateStatus();
      },
      onCancel: () => {
        uiModalOpen = false;
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
      transcript.add(new Spacer(1));
      transcript.add(new UserBox(`> ${extra}`));
      tui.requestRender();
    }
    session.appendMessage({ role: "system", content });
    if (typeof session.appendEvent === "function") {
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
      const next = store.create(process.cwd(), provider.id);
      session.releaseLock?.();
      session = next;
      sessionTrusted = false;
      session.messages.length = 0;
      content.clear();
      runtime.resetContextUsage();
      runtime.resetSessionState(session);
      syncGoalPanel();
    },
    updateStatus,
    runDoctor,
    runMcp,
    runCompact,
    runExport,
    openModelPicker,
    openProviderPicker,
    openEffortPicker,
    openThinkingPicker,
    openThemePicker,
    openAgentPicker,
    openSessionsPicker,
    showUsage,
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
    extensionDoctorJson: () => extensionLoader.doctorJson(),
    reloadExtensions,
    setProjectTrust: (decision) => {
      if (decision === "allow") {
        trustProject(process.cwd());
        appendLine("project trusted; run /reload to apply");
      } else if (decision === "deny") {
        denyProject(process.cwd());
        appendLine("project denied; run /reload to apply");
      } else {
        untrustProject(process.cwd());
        appendLine("project trust reset (undecided); run /reload to apply");
      }
      appendLine(
        `current status: ${
          isProjectDenied(process.cwd())
            ? "denied"
            : isProjectTrusted(process.cwd())
              ? "trusted"
              : "undecided"
        }`,
      );
    },
    switchModel: switchModelTarget,
    startProviderSetup,
    setEffort: setThinkingTarget,
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
    listAgents: () => {
      // Rescan so deleted or newly added personas are reflected immediately.
      agentReg = new DefaultAgentRegistry(process.cwd(), {
        projectTrusted: isProjectTrusted(process.cwd()),
      });
      const activeName = runtime.getPersona()?.name;
      if (activeName && !agentReg.get(activeName)) {
        runtime.setPersona(undefined);
        updateStatus();
      }
      const active = runtime.getPersona()?.name;
      return agentReg.list().map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        active: agent.name === active,
      }));
    },
    activateAgent: (name) => {
      agentReg = new DefaultAgentRegistry(process.cwd(), {
        projectTrusted: isProjectTrusted(process.cwd()),
      });
      const persona = agentReg.get(name);
      if (!persona) {
        appendLine(`unknown agent: ${name}`);
        return;
      }
      runtime.setPersona(persona);
      appendLine(
        `agent: ${persona.name}${persona.description ? ` — ${persona.description}` : ""}`,
      );
      updateStatus();
    },
    runTurn,
    isTurnActive: () => activeTurnController !== null,
    requestExit: () => {
      void closeInteractiveSession(
        extensionLoader,
        () =>
          shutdownLsp().finally(() =>
            mcpManager.close().finally(() => {
              tui.stop();
            }),
          ),
        (code) => process.exit(code),
      );
    },
  };

  function restoreTranscript(next: any): void {
    streamText.finalize();
    transcript.reset();
    // Drop stale references so toggles only affect the resumed transcript.
    toolBoxes.length = 0;
    toolBoxesById.clear();
    thinkingText = null;
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
      if (message.role === "system") {
        // Continuations are one-shot instructions, but the user must still be
        // able to see what the agent was told after a compaction.
        const text = textOf(message.content).trim();
        if (text.startsWith("Continuation after compaction:")) {
          transcript.add(new Spacer(1));
          transcript.add(new Text(theme.tokens.dim(text), 1, 0));
        }
        continue;
      }

      if (message.role === "user") {
        const text = textOf(message.content).trim();
        if (text) {
          transcript.add(new Spacer(1));
          transcript.add(new UserBox(`> ${text}`));
        }
        continue;
      }

      if (message.role === "assistant") {
        const thinking = String((message as any).thinking ?? "").trim();
        if (thinking && showThinking) {
          transcript.add(new Spacer(1));
          const thinkingBlock = new ThinkingBlock(theme);
          thinkingBlock.append(thinking);
          transcript.add(thinkingBlock);
        }
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
    if (id === session.id) {
      appendLine(`already on session ${id}`);
      return;
    }
    let next;
    try {
      next = store.resume(id);
    } catch (err) {
      appendLine(
        `could not resume session: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!next) {
      appendLine(`could not resume session: ${id}`);
      return;
    }
    const previous = session;
    session = next;
    previous.releaseLock?.();
    session.appendEvent?.({ type: "session_resumed", from: previous.id });
    runtime.restoreSessionState(next);
    syncGoalPanel();
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
    session.appendEvent?.({ type: "session_renamed", title: trimmed });
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
    tui.requestRender();
  }

  async function reloadExtensions(): Promise<void> {
    // Build the replacement set first. Until staging succeeds the previous set
    // stays live, so a failed reload changes nothing but the reported error.
    let staged: StagedExtensionSet;
    try {
      staged = await extensionLoader.stageExtensions();
    } catch (error) {
      extensionLoader.reportTopLevelError(error, "loadAll");
      appendLine(
        `extensions: reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      tui.requestRender();
      return;
    }

    const previous = extensionLoader.loadedExtensions();
    // Notify the outgoing set while its generation is still current.
    for (const loaded of previous) {
      const handlers = loaded.registries?.handlers?.get?.("session_shutdown");
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
    // One swap: the staged generation becomes live, old handlers go stale.
    await extensionLoader.commitStaged(staged);

    // Remove previously bridged providers, then re-bridge.
    for (const name of extensionProviderNames) {
      delete (config.providers as Record<string, unknown>)[name];
      modelCache.delete(name);
    }
    extensionProviderNames.clear();
    for (const loaded of extensionLoader.loadedExtensions()) {
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
        (config.providers as Record<string, unknown>)[name] = {
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
    runtime.setTools(currentTools(true));

    // Force context caches (AGENTS.md and skills) and registries to rescan.
    runtime.invalidateContextCaches();
    // Reset the cached signature so cachedSkillRegistry() actually rebuilds
    // instead of returning the stale registry.
    skillSignature = "";
    skillReg = cachedSkillRegistry();
    agentReg = new DefaultAgentRegistry(process.cwd(), {
      projectTrusted: isProjectTrusted(process.cwd()),
    });

    // Refresh project trust-dependent registries and persona state.
    const currentPersonaName = runtime.getPersona()?.name;
    const reloadedPersona = currentPersonaName
      ? agentReg.get(currentPersonaName)
      : undefined;
    if (reloadedPersona) {
      runtime.setPersona(reloadedPersona);
    } else {
      const selected = resolveConfiguredAgent(agentReg, config.runtime.agent);
      if (selected.persona) runtime.setPersona(selected.persona);
      else if (selected.warning)
        appendLine(`atom-lite: ${selected.warning}`, theme.tokens.warning);
    }
    updateStatus();

    // Emit session_start with reason reload.
    for (const loaded of extensionLoader.loadedExtensions()) {
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
    refreshCommandRegistry(true);
    appendLine(
      `extensions: ${extensionLoader.processedCount()} reloaded (see /extensions)`,
    );
    await extensionDispatch("config_change", {
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

  extensionUICallbacks.select = (title, options, _opts) =>
    dialogBoundary.run<string | undefined>("select", ({ resolve }) => {
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

  extensionUICallbacks.confirm = (title, message, _opts) =>
    dialogBoundary.run<boolean>("confirm", ({ resolve }) => {
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

  extensionUICallbacks.input = (title, _placeholder, _opts) =>
    dialogBoundary.run<string | undefined>("input", ({ resolve }) => {
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
    const layout = (content as any).childLines ?? (content as any).mouseLayout;
    const heights: number[] =
      layout?.width === width && layout.children.length === children.length
        ? layout.parts
          ? layout.parts.map((part: string[]) => part.length)
          : layout.children.map((entry: { height: number }) => entry.height)
        : children.map((component) => component.render(width).length);
    const contentBlocks: { id: string; height: number }[] = heights.map(
      (height, index) => ({ id: `content:${index}`, height }),
    );
    const inner = blockAtScreenRow(
      contentBlocks,
      screenY,
      outputHeight,
      output.scrollTop,
    );
    if (!inner) return false;
    const child = children[Number(inner.id.slice("content:".length))];
    if (!(child instanceof ToolBox)) return false;
    child.toggleExpanded();
    (content as any).childLines = undefined;
    (content as any).mouseLayout = undefined;
    return true;
  }

  tui.addInputListener((data: string) => {
    const event = parseSgrMouse(data);
    if (!event) return undefined;
    // Let the alt-screen TUI own wheel scrolling; only intercept clicks.
    if (event.type === "wheel") return undefined;
    if (!mouseEnabled) return { consume: true };
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
        return { consume: true };
      }
      if (matchesBinding("newSession")) {
        commandContext.newSession();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("searchSessions")) {
        openSessionsPicker("workspace");
        return { consume: true };
      }
      if (matchesBinding("scrollUp")) {
        output.scrollBy(-5);
        return { consume: true };
      }
      if (matchesBinding("scrollDown")) {
        output.scrollBy(5);
        return { consume: true };
      }
      if (matchesBinding("toggleThinking")) {
        showThinking = !showThinking;
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("toggleGoalPanel")) {
        goalPanel.toggle();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesBinding("cycleThinking")) {
        const levels = supportedThinkingLevels();
        if (levels.length === 0 || !currentModelCapabilities?.reasoning) {
          appendLine("Current model does not support thinking");
        } else {
          const idx = levels.indexOf(effortLevel);
          const next = levels[(idx + 1) % levels.length];
          setThinkingTarget(next);
        }
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
        tui.requestRender();
        return { consume: true };
      }
    }
    return undefined;
  });

  runtime.setEventSink((e) => {
    if (e.type === "thinking_delta") {
      activity.setPhase("thinking");
      if (!showThinking) return;
      if (!thinkingText) {
        thinkingText = new ThinkingBlock(theme);
        transcript.add(new Spacer(1));
        transcript.add(thinkingText);
      }
      thinkingText.append(e.text);
      tui.requestRender();
    } else if (e.type === "assistant_delta") {
      activity.setPhase("working");
      thinkingText = null;
      appendDelta(e.text);
    } else if (e.type === "assistant_text") {
      activity.setPhase("working");
      thinkingText = null;
      appendDelta(e.text);
      finalizeText();
    } else if (e.type === "context_usage") {
      updateStatus();
    } else if (e.type === "usage") {
      turnOutputTokens += e.output ?? 0;
      turnModelMs += e.elapsedMs ?? 0;
    } else if (e.type === "background_task_complete") {
      appendLine(
        `background task ${e.id}: ${e.status} (exit ${e.exitCode ?? "null"})`,
        theme.tokens.dim,
      );
      tui.requestRender();
    } else if (e.type === "goal_state" || e.type === "ledger_state") {
      syncGoalPanel();
    } else if (e.type === "compaction_continuation") {
      appendLine(e.text, theme.tokens.dim);
      tui.requestRender();
    } else if (e.type === "context_compaction_started") {
      appendLine(
        `compacting with ${e.model} (${e.strategy})`,
        theme.tokens.dim,
      );
      tui.requestRender();
    } else if (e.type === "context_compaction_failed") {
      appendLine(`compaction failed: ${e.reason}`, theme.tokens.warning);
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
    } else if (e.type === "response_truncated") {
      appendLine(
        `response truncated: ${e.model} hit its output token limit`,
        theme.tokens.warning,
      );
      tui.requestRender();
    } else if (e.type === "error") {
      appendLine(e.message, theme.tokens.error);
      tui.requestRender();
    } else if (e.type === "model_switched") {
      if (typeof session.appendEvent === "function") {
        session.appendEvent({
          type: "model_switched",
          provider: e.provider,
          model: e.model,
        });
      }
      updateStatus();
    } else if (e.type === "tool_call") {
      thinkingText = null;
      finalizeText();
      activity.setPhase("working", e.name);
      const box = new ToolBox({ id: e.id, name: e.name, args: e.args });
      box.setExpanded(expandTools);
      transcript.add(new Spacer(1));
      transcript.add(box);
      toolBoxes.push(box);
      toolBoxesById.set(box.id, box);
      tui.requestRender();
    } else if (e.type === "tool_output") {
      const box = toolBoxesById.get(e.toolCallId);
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
      thinkingText = null;
      finalizeText();
      activity.stop();
    }
  });

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
        runtime.setTools(currentTools(true));
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
      // Shared key=token-value redaction (api key / token / secret /
      // password / authorization in `key: value` or `key=value` forms).
      return redactSecrets(out);
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
      appendLine(
        session.messages.length <= 6
          ? "nothing to compact"
          : "compaction failed; see the notice above",
      );
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
        transcript.add(new Spacer(1));
        transcript.add(new Spacer(1));
        transcript.add(new UserBox(`> ${text}`));
        tui.requestRender();
        await runTurn(text);
      }
      tui.requestRender();
      return;
    }
    // One reporter for every command dispatch failure, slash or bare name, so
    // both paths surface the same attributable error line.
    const reportCommandFailure = (error: unknown): void => {
      appendLine(
        `command failed: ${error instanceof Error ? error.message : String(error)}`,
        theme.tokens.error,
      );
    };
    if (trimmed.startsWith("/")) {
      let result;
      try {
        result = await commandRegistry.dispatch(trimmed, commandContext);
      } catch (error) {
        reportCommandFailure(error);
        return;
      }
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
      try {
        await commandRegistry.dispatch(
          `/${bare} ${trimmed.slice(bare.length)}`,
          commandContext,
        );
      } catch (error) {
        reportCommandFailure(error);
      }
      return;
    }

    if (activeTurnController) {
      messageQueue.push(trimmed);
      appendLine(`queued: ${trimmed}`, theme.tokens.dim);
      tui.requestRender();
      return;
    }
    transcript.add(new Spacer(1));
    transcript.add(new UserBox(`> ${trimmed}`));
    tui.requestRender();
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

  questions.handler = interactive
    ? (request, signal) =>
        new Promise<QuestionOutcome>((resolve) => {
          let settled = false;
          let attempts = 0;
          let timer: NodeJS.Timeout | undefined;

          const finish = (outcome: QuestionOutcome) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
            questionDock.clear();
            uiModalOpen = false;
            tui.setFocus(input);
            activity.setPhase("working");
            tui.requestRender();
            resolve(outcome);
          };
          const onAbort = () => finish({ status: "cancelled" });
          signal?.addEventListener("abort", onAbort, { once: true });

          // A permission request or another modal owns the keyboard first.
          // Wait for it instead of clobbering its prompt.
          const mount = () => {
            if (settled) return;
            if (uiModalOpen && attempts < 1200) {
              attempts += 1;
              timer = setTimeout(mount, 50);
              return;
            }
            if (uiModalOpen) {
              finish({
                status: "cancelled",
                message: "Another prompt is open; answer it first.",
              });
              return;
            }
            uiModalOpen = true;
            closeOverlay();
            dropdownContainer.clear();
            activity.setPhase("waiting");
            const prompt = new QuestionPromptView({
              questions: request.questions,
              theme,
              onOutcome: finish,
            });
            questionDock.addChild(prompt);
            tui.setFocus(prompt);
            tui.requestRender();
          };
          mount();
        })
    : undefined;

  process.on("SIGTERM", () => {
    void mcpManager.close().finally(() => {
      tui.stop();
      process.exit(0);
    });
  });

  tui.start();
  // Pay the one-time cold render at startup so the first keystroke or wheel
  // event does not stall on layout/JIT warm-up.
  (tui as unknown as { doRender(): void }).doRender();
  const configuredUntrusted =
    configuredAgent.warning !== undefined &&
    agentReg.untrusted().some((agent) => agent.name === config.runtime.agent);
  if (configuredAgent.warning && !configuredUntrusted) {
    appendLine(`atom-lite: ${configuredAgent.warning}`, theme.tokens.warning);
  }
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
