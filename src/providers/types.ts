import type {
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
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  getModelInfo?(): Promise<ModelInfo | undefined>;
  listModels?(): Promise<string[]>;
}

export interface ProviderRegistry {
  get(id: string): ProviderAdapter | undefined;
  register(adapter: ProviderAdapter): void;
  list(): string[];
}
