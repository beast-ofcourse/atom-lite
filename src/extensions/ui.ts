import type { ExtensionContext, ExtensionUIContext } from "./types.js";
import type { ExtensionRegistries } from "./api.js";

export interface DialogSettlers<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Tracks dialog promises that are waiting on an overlay. When that overlay is
 * torn down we reject them instead of leaving the extension's `await` pending
 * forever, which would hang the turn.
 */
export class DialogBoundary {
  private readonly pending = new Set<{
    label: string;
    reject: (error: Error) => void;
  }>();

  run<T>(
    label: string,
    setup: (settlers: DialogSettlers<T>) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const entry = {
        label,
        reject: (error: Error) => {
          if (settled) return;
          settled = true;
          this.pending.delete(entry);
          reject(error);
        },
      };
      const safeResolve = (value: T | PromiseLike<T>) => {
        if (settled) return;
        settled = true;
        this.pending.delete(entry);
        resolve(value);
      };
      const safeReject = (reason?: unknown) =>
        entry.reject(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      // Wire the settlers before tracking the dialog: an app closes the
      // previous overlay at the start of setup, which must not cancel this
      // brand-new dialog.
      try {
        setup({ resolve: safeResolve, reject: safeReject });
      } catch (error) {
        safeReject(error);
        return;
      }
      if (!settled) this.pending.add(entry);
    });
  }

  cancelAll(reason = "dialog closed"): void {
    for (const entry of [...this.pending]) {
      entry.reject(new Error(`${reason}: ${entry.label}`));
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export interface ExtensionUICallbacks {
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  requestRender?: () => void;
  getToolsExpanded?: () => boolean;
  setToolsExpanded?: (expanded: boolean) => void;
  select?: (
    title: string,
    options: string[],
    opts?: any,
  ) => Promise<string | undefined>;
  confirm?: (title: string, message: string, opts?: any) => Promise<boolean>;
  input?: (
    title: string,
    placeholder?: string,
    opts?: any,
  ) => Promise<string | undefined>;
  editor?: (
    title: string,
    prefill?: string,
    opts?: any,
  ) => Promise<string | undefined>;
  custom?: <T>(factory: any, options?: any) => Promise<T>;
  pasteToEditor?: (text: string) => void;
  setEditorText?: (text: string) => void;
  getEditorText?: () => string;
  onTerminalInput?: (
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
}

export function createDefaultExtensionUI(
  registries: ExtensionRegistries,
  ctx: ExtensionContext,
  callbacks: ExtensionUICallbacks = {},
): ExtensionUIContext {
  const noopUnsubscribe = () => {};
  return {
    notify: (message, type) => {
      if (callbacks.notify) callbacks.notify(message, type);
      else {
        // eslint-disable-next-line no-console
        console.error(`[extension] ${type ?? "info"}: ${message}`);
      }
    },
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
    select: (title, options, opts) =>
      callbacks.select
        ? callbacks.select(title, options, opts)
        : Promise.resolve(undefined),
    confirm: (title, message, opts) =>
      callbacks.confirm
        ? callbacks.confirm(title, message, opts)
        : Promise.resolve(false),
    input: (title, placeholder, opts) =>
      callbacks.input
        ? callbacks.input(title, placeholder, opts)
        : Promise.resolve(undefined),
    editor: (title, prefill, opts) =>
      callbacks.editor
        ? callbacks.editor(title, prefill, opts)
        : Promise.resolve(undefined),
    custom: <T>(factory: any, options?: any) =>
      callbacks.custom
        ? callbacks.custom<T>(factory, options)
        : Promise.resolve(undefined as T),
    pasteToEditor: (text) => callbacks.pasteToEditor?.(text),
    setEditorText: (text) => callbacks.setEditorText?.(text),
    getEditorText: () =>
      callbacks.getEditorText ? callbacks.getEditorText() : "",
    onTerminalInput: (handler) =>
      callbacks.onTerminalInput ? callbacks.onTerminalInput(handler) : () => {},
    getToolsExpanded: () =>
      callbacks.getToolsExpanded
        ? callbacks.getToolsExpanded()
        : registries.toolsExpanded,
    setToolsExpanded: (expanded) => {
      registries.toolsExpanded = expanded;
      if (callbacks.setToolsExpanded) callbacks.setToolsExpanded(expanded);
      else callbacks.requestRender?.();
    },
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "theme switching is not available",
    }),
  };
}
