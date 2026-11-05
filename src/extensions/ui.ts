import type { ExtensionContext, ExtensionUIContext } from "./types.js";
import type { ExtensionRegistries } from "./api.js";

export interface ExtensionUICallbacks {
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  requestRender?: () => void;
  getToolsExpanded?: () => boolean;
  setToolsExpanded?: (expanded: boolean) => void;
}

export function createDefaultExtensionUI(
  registries: ExtensionRegistries,
  ctx: ExtensionContext,
  callbacks: ExtensionUICallbacks = {},
): ExtensionUIContext {
  const noopUnsubscribe = () => {};
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => {
      if (callbacks.notify) callbacks.notify(message, type);
      else {
        // eslint-disable-next-line no-console
        console.error(`[extension] ${type ?? "info"}: ${message}`);
      }
    },
    onTerminalInput: () => noopUnsubscribe,
    setStatus: (key, text) => {
      if (text === undefined) registries.status.delete(key);
      else registries.status.set(key, text);
      callbacks.requestRender?.();
    },
    setWorkingMessage: (message) => {
      registries.workingMessage = message;
    },
    setWorkingVisible: (visible) => {
      registries.workingVisible = visible;
    },
    setWorkingIndicator: (options) => {
      registries.workingIndicator = options;
    },
    setHiddenThinkingLabel: (label) => {
      registries.hiddenThinkingLabel = label;
    },
    setWidget: (key, content, options) => {
      if (content === undefined) registries.uiWidgets.delete(key);
      else
        registries.uiWidgets.set(key, {
          key,
          content,
          placement: options?.placement ?? "aboveEditor",
        });
      callbacks.requestRender?.();
    },
    setFooter: (factory) => {
      registries.footerFactory = factory;
      callbacks.requestRender?.();
    },
    setHeader: (factory) => {
      registries.headerFactory = factory;
      callbacks.requestRender?.();
    },
    setTitle: (title) => {
      registries.title = title;
      callbacks.requestRender?.();
    },
    custom: async <T>() => undefined as T,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getToolsExpanded: () => (callbacks.getToolsExpanded ? callbacks.getToolsExpanded() : registries.toolsExpanded),
    setToolsExpanded: (expanded) => {
      registries.toolsExpanded = expanded;
      if (callbacks.setToolsExpanded) callbacks.setToolsExpanded(expanded);
      else callbacks.requestRender?.();
    },
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "theme switching is not available" }),
  };
}
