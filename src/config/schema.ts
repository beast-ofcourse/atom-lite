import { z } from "zod";

const CompactionStrategySchema = z.enum(["auto", "summary", "native"]);

export const ProviderConfigSchema = z
  .object({
    type: z.string(),
    baseUrl: z.string().url().optional(),
    model: z.string(),
    apiKeyEnv: z.string().nullable().optional(),
    apiKey: z.string().nullable().optional(),
    keepAlive: z.string().optional(),
    think: z.union([z.boolean(), z.string()]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    /** Explicit context window for custom/local models without metadata. */
    contextWindow: z.number().int().positive().optional(),
    /** Whether the model supports image/vision input. Overrides provider metadata. */
    supportsVision: z.boolean().optional(),
    /** Provider-level compaction policy. Model settings override it. */
    compactionStrategy: CompactionStrategySchema.optional(),
    /** Per-model compaction policy overrides. */
    models: z
      .record(
        z.string(),
        z
          .object({ compactionStrategy: CompactionStrategySchema.optional() })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    maxParallelToolCalls: z.number().int().positive().default(10),
    maxToolOutputBytes: z.number().int().positive().default(30_000),
    maxBashTimeMs: z.number().int().positive().default(120_000),
    bashConcurrency: z.enum(["serial", "parallel"]).default("serial"),
    mode: z.enum(["plan", "yolo"]).default("yolo"),
    /** Default primary persona applied at startup. User config only. */
    agent: z.string().min(1).optional(),
    maxTokensPerSession: z.number().int().positive().nullable().default(null),
    maxTokensPerTurn: z.number().int().positive().nullable().default(null),
    /**
     * Accepted for backward compatibility but ignored. Automatic checkpoints
     * were removed entirely (ADR 0018); this schema is `.strict()`, so the key
     * must stay accepted or old user configs fail to load.
     */
    checkpointing: z.boolean().optional(),
  })
  .strict();

export const RepoMapConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxTokens: z.number().int().nonnegative().default(1200),
    maxFiles: z.number().int().nonnegative().default(400),
  })
  .strict();

export const WebFetchConfigSchema = z
  .object({
    cacheTtlSeconds: z.number().int().positive().default(300),
    maxBytes: z.number().int().positive().default(5_242_880),
    maxOutputChars: z.number().int().positive().default(30_000),
    extract: z.enum(["auto", "main", "full"]).default("auto"),
  })
  .strict();

export const WebSearchConfigSchema = z
  .object({
    provider: z
      .enum(["auto", "ddg", "tavily", "brave", "exa", "serper"])
      .default("auto"),
    maxResults: z.number().int().positive().max(20).default(8),
    cacheTtlSeconds: z.number().int().positive().default(120),
    fallback: z.boolean().default(true),
  })
  .strict();

export const WebConfigSchema = z
  .object({
    fetch: WebFetchConfigSchema.prefault({}),
    search: WebSearchConfigSchema.prefault({}),
  })
  .strict();

export type WebConfig = z.infer<typeof WebConfigSchema>;

export const ContextConfigSchema = z
  .object({
    maxInputTokens: z.number().int().positive().nullable().default(null),
    reserveOutputTokens: z.number().int().positive().default(4096),
    compactAtPercent: z.number().int().min(1).max(100).default(85),
    maxProjectInstructionBytes: z.number().int().positive().default(30000),
    compactEveryNTurns: z.number().int().min(0).default(0),
    /**
     * Optional model used only for compaction summaries. Unset means use the
     * active model, so installing this field cannot change default behavior.
     */
    compactionModel: z.string().min(1).nullable().default(null),
    /** Global compaction policy. Provider and model settings override it. */
    compactionStrategy: CompactionStrategySchema.default("auto"),
    /** Token budget for the recent tail kept beside a memory checkpoint. */
    keepTokens: z.number().int().nonnegative().default(15000),
    /** Prepare summaries ahead of the compaction trigger. */
    background: z.boolean().default(false),
    /** Opt-in prompt-cache keep-alive. */
    warming: z
      .union([
        z.boolean(),
        z
          .object({
            interval: z
              .union([z.literal("auto"), z.number().int().positive()])
              .default("auto"),
            duration: z.number().int().positive().default(1_800_000),
          })
          .strict(),
      ])
      .default(false),
    /**
     * Compaction trigger reserve. A percent string is a share of the model
     * window; a number is an exact token reserve. Unset derives from
     * compactAtPercent and is independent of reserveOutputTokens.
     */
    buffer: z
      .union([
        z.string().regex(/^(?:[1-9]|[1-9]\d)%$/),
        z.number().int().nonnegative(),
      ])
      .nullable()
      .default(null),
    /** Prompt-cache prefix layout: off keeps today's message order. */
    cacheMode: z.enum(["off", "automatic", "explicit"]).default("off"),
    /** Bounded, deterministic repo map injected as trailing context. */
    repoMap: RepoMapConfigSchema.prefault({}),
  })
  .strict();

export const ModelPricingSchema = z
  .object({
    /** USD per one million tokens; omitted rates are treated as zero. */
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  })
  .strict();

export const UsageConfigSchema = z
  .object({
    /** Opt-in per-call usage ledger. Off by default. User config only. */
    ledgerEnabled: z.boolean().default(false),
    /** Override for the ledger file location; null uses the user config dir. */
    ledgerPath: z.string().min(1).nullable().default(null),
    /** Explicit per-model prices in USD per million tokens. No guessing. */
    prices: z.record(z.string(), ModelPricingSchema).default({}),
  })
  .strict();

export const SessionsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const LspServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    extensions: z.array(z.string()).default([]),
    rootMarkers: z.array(z.string()).default([]),
    initialization: z.record(z.string(), z.unknown()).optional(),
    disabled: z.boolean().default(false),
  })
  .strict();

export const LspConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    servers: z.record(z.string(), LspServerConfigSchema).default({}),
  })
  .strict();

export const UiConfigSchema = z
  .object({
    theme: z.string().default("auto"),
    mouse: z.boolean().default(true),
    vimMode: z.boolean().default(false),
    showThinking: z.boolean().default(true),
  })
  .strict();

export const KeybindingsConfigSchema = z
  .object({
    jumpBottom: z.string().nullable().default("ctrl+b"),
    newSession: z.string().nullable().default("ctrl+n"),
    searchSessions: z.string().nullable().default("ctrl+f"),
    scrollUp: z.string().nullable().default("ctrl+up"),
    scrollDown: z.string().nullable().default("ctrl+down"),
    toggleThinking: z.string().nullable().default("ctrl+t"),
    cycleThinking: z.string().nullable().default(null),
    toggleGoalPanel: z.string().nullable().default("ctrl+j"),
    inputHistoryUp: z.string().nullable().default("up"),
    inputHistoryDown: z.string().nullable().default("down"),
  })
  .strict();

export const McpServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    enabled: z.boolean().default(true),
    requiresApproval: z.boolean().default(false),
    startupTimeoutMs: z.number().int().positive().default(10_000),
    callTimeoutMs: z.number().int().positive().default(60_000),
  })
  .strict();

export const McpServersConfigSchema = z
  .record(z.string(), McpServerConfigSchema)
  .default({});

export const ExtensionsConfigSchema = z
  .object({
    trustedProjects: z.array(z.string()).default([]),
    deniedProjects: z.array(z.string()).default([]),
  })
  .strict();

export const ConfigSchema = z
  .object({
    defaultProvider: z.string().default("openai-compatible"),
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    modelThinkingLevels: z
      .record(
        z.string(),
        z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      )
      .default({}),
    modelOverrides: z
      .record(
        z.string(),
        z
          .object({
            contextWindow: z.number().int().positive().optional(),
            maxTokens: z.number().int().positive().optional(),
            reasoning: z.boolean().optional(),
            thinkingLevelMap: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
          })
          .strict(),
      )
      .default({}),
    runtime: RuntimeConfigSchema.prefault({}),
    context: ContextConfigSchema.prefault({}),
    web: WebConfigSchema.prefault({}),
    sessions: SessionsConfigSchema.prefault({}),
    usage: UsageConfigSchema.prefault({}),
    lsp: LspConfigSchema.prefault({}),
    ui: UiConfigSchema.prefault({}),
    keybindings: KeybindingsConfigSchema.prefault({}),
    mcpServers: McpServersConfigSchema,
    extensions: ExtensionsConfigSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
