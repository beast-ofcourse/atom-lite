import type {
  Message,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../types.js";

// Re-export for convenience
export type { ModelInfo };

export interface ProviderAdapter {
  readonly id: string;
  /** Concrete model currently selected by this adapter, when known. */
  readonly model?: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  /** Optional provider-managed compaction that returns an opaque checkpoint. */
  compact?(request: {
    model: string;
    messages: Message[];
    recentUserMessages?: Message[];
    keepTokens: number;
  }): Promise<{ payload: string }>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  getModelInfo?(): Promise<ModelInfo | undefined>;
  listModels?(): Promise<string[]>;
}

export interface ProviderRegistry {
  get(id: string): ProviderAdapter | undefined;
  register(adapter: ProviderAdapter): void;
  list(): string[];
}
