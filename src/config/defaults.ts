import { DEFAULT_LIMITS } from "../types.js";

export const DEFAULT_CONFIG = {
  defaultProvider: "openai-compatible",
  providers: {} as Record<string, unknown>,
  runtime: {
    ...DEFAULT_LIMITS,
    bashConcurrency: "serial",
    approvalMode: "ask",
  },
  context: {
    maxInputTokens: null as number | null,
    reserveOutputTokens: 4096,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
  },
  sessions: { enabled: true, retentionDays: null as number | null },
};
