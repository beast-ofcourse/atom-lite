import { DEFAULT_LIMITS } from "../types.js";

export const DEFAULT_CONFIG = {
  defaultProvider: "kilo",
  providers: {
    kilo: {
      type: "openai-compatible",
      baseUrl: "https://api.kilo.ai/api/gateway",
      model: "kilo-auto/free",
      apiKeyEnv: null,
    },
  } as Record<string, unknown>,
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
    compactEveryNTurns: 0,
  },
  sessions: { enabled: true, retentionDays: null as number | null },
  ui: {
    theme: "auto",
    mouse: true,
    vimMode: false,
    showThinking: true,
  },
  mcpServers: {} as Record<string, unknown>,
  extensions: {
    trustedProjects: [] as string[],
  },
};
