import type { ExtensionAPI } from "./api.js";

export type ExtensionModule = {
  factory?: (api: ExtensionAPI) => unknown | Promise<unknown>;
  exports: Record<string, unknown>;
  bind?(api: ExtensionAPI): void;
  dispose?(): void;
};

export interface ExtensionModuleRuntime {
  load(entryPath: string): Promise<ExtensionModule>;
}

export type ModuleRuntimeOverrides = Partial<
  Record<string, ExtensionModuleRuntime>
>;
