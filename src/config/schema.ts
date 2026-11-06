import { z } from "zod";

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
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    maxParallelToolCalls: z.number().int().positive().default(10),
    maxToolOutputBytes: z.number().int().positive().default(30_000),
    maxBashTimeMs: z.number().int().positive().default(120_000),
    bashConcurrency: z.enum(["serial", "parallel"]).default("serial"),
    mode: z.enum(["plan", "yolo"]).default("plan"),
    maxTokensPerSession: z.number().int().positive().nullable().default(null),
    maxTokensPerTurn: z.number().int().positive().nullable().default(null),
    /** Enable checkpointing in non-interactive runs. Interactive runs always enable it. */
    checkpointing: z.boolean().default(false),
  })
  .strict();

export const ContextConfigSchema = z
  .object({
    maxInputTokens: z.number().int().positive().nullable().default(null),
    reserveOutputTokens: z.number().int().positive().default(4096),
    compactAtPercent: z.number().int().min(1).max(100).default(85),
    maxProjectInstructionBytes: z.number().int().positive().default(30000),
    compactEveryNTurns: z.number().int().min(0).default(0),
  })
  .strict();

export const SessionsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().positive().nullable().default(null),
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
    runtime: RuntimeConfigSchema.prefault({}),
    context: ContextConfigSchema.prefault({}),
    sessions: SessionsConfigSchema.prefault({}),
    ui: UiConfigSchema.prefault({}),
    mcpServers: McpServersConfigSchema,
    extensions: ExtensionsConfigSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
