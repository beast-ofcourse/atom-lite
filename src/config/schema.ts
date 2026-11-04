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
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().default(40),
    maxToolCalls: z.number().int().positive().default(100),
    maxExecutionMs: z.number().int().positive().default(1_800_000),
    maxParallelToolCalls: z.number().int().positive().default(4),
    maxToolOutputBytes: z.number().int().positive().default(30_000),
    maxBashTimeMs: z.number().int().positive().default(120_000),
    bashConcurrency: z.enum(["serial", "parallel"]).default("serial"),
    approvalMode: z.enum(["ask", "trusted", "deny"]).default("ask"),
  })
  .strict();

export const ContextConfigSchema = z
  .object({
    maxInputTokens: z.number().int().positive().nullable().default(null),
    reserveOutputTokens: z.number().int().positive().default(4096),
    compactAtPercent: z.number().int().min(1).max(100).default(85),
    maxProjectInstructionBytes: z.number().int().positive().default(30000),
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

export const ConfigSchema = z
  .object({
    defaultProvider: z.string().default("openai-compatible"),
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    runtime: RuntimeConfigSchema.prefault({}),
    context: ContextConfigSchema.prefault({}),
    sessions: SessionsConfigSchema.prefault({}),
    ui: UiConfigSchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
