import { Container, fuzzyFilter, SelectList, Text } from "@earendil-works/pi-tui";

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
}

export interface SearchablePickerOptions {
  tui: any;
  container: any;
  title: string;
  items: PickerItem[];
  maxVisible?: number;
  initialQuery?: string;
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
  restoreFocus?: () => void;
}

export interface SearchablePicker {
  /** Replace the full item set (e.g. after live model discovery). */
  updateItems(items: PickerItem[]): void;
  /** Update the dim status line under the title. */
  setStatus(status: string): void;
  close(): void;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

const selectListTheme = {
  selectedPrefix: (s: string) => s,
  selectedText: (s: string) => `\x1b[7m${s}${RESET}`,
  description: (s: string) => `${DIM}${s}${RESET}`,
  scrollInfo: (s: string) => `${DIM}${s}${RESET}`,
  noMatch: (s: string) => `${DIM}${s}${RESET}`,
};

/** Fuzzy-filter picker items on label, description and value. */
export function filterPickerItems(
  items: PickerItem[],
  query: string,
): PickerItem[] {
  const q = query.trim();
  if (!q) return items;
  return fuzzyFilter(items, q, (item) =>
    `${item.label} ${item.description ?? ""} ${item.value}`,
  );
}

function isKeyRelease(data: string): boolean {
  return /\x1b\[\d+;\d+:3[ABCD]/.test(data);
}

/** Extract bracketed-paste payloads; returns null for non-paste input. */
function extractPaste(data: string): string | null {
  if (!data.includes("\x1b[200~")) return null;
  return data
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/[\x00-\x1f]/g, "");
}

export function openSearchablePicker(
  options: SearchablePickerOptions,
): SearchablePicker {
  const {
    tui,
    container,
    title,
    items: initialItems,
    maxVisible = 15,
    initialQuery = "",
    onSelect,
    onCancel,
    restoreFocus,
  } = options;

  let allItems = initialItems;
  let query = initialQuery;
  let closed = false;
  let selectedValue: string | undefined;

  const wrapper = new Container();
  const titleText = new Text(`${CYAN}${title}${RESET}`);
  const filterText = new Text("");
  const statusText = new Text("");
  const listHost = new Container();
  wrapper.addChild(titleText);
  wrapper.addChild(filterText);
  wrapper.addChild(listHost);
  wrapper.addChild(statusText);
  container.addChild(wrapper);

  let list: any = null;

  function renderFilter(): void {
    const shown = query ? `${DIM}search:${RESET} ${query}${CYAN}▏${RESET}` : `${DIM}type to search…${RESET}`;
    filterText.setText(shown);
  }

  function rebuild(): void {
    const filtered = filterPickerItems(allItems, query);
    listHost.clear();
    if (filtered.length === 0) {
      list = null;
      listHost.addChild(new Text(`${DIM}  no models match “${query}”${RESET}`));
      renderFilter();
      tui.requestRender();
      return;
    }
    list = new SelectList(
      filtered as any,
      Math.max(1, Math.min(maxVisible, filtered.length)),
      selectListTheme as any,
      { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 56 },
    );
    const idx = selectedValue
      ? filtered.findIndex((i) => i.value === selectedValue)
      : 0;
    if (idx > 0) list.setSelectedIndex(idx);
    list.onSelect = (item: any) => {
      selectedValue = item.value;
      close();
      onSelect(item);
    };
    list.onCancel = () => {
      close();
      onCancel();
    };
    listHost.addChild(list);
    renderFilter();
    tui.requestRender();
  }

  function onKey(data: string): any {
    if (closed) return { consume: true };
    if (isKeyRelease(data)) return { consume: true };

    if (data === "\x03") {
      close();
      onCancel();
      return { consume: true };
    }
    if (data === "\x1b") {
      close();
      onCancel();
      return { consume: true };
    }
    if (data === "\r" || data === "\n") {
      const item = list?.getSelectedItem?.();
      if (item) {
        selectedValue = item.value;
        close();
        onSelect(item);
      }
      return { consume: true };
    }
    if (data === "\x7f" || data === "\b") {
      query = query.slice(0, -1);
      rebuild();
      return { consume: true };
    }
    if (data === "\x15") {
      query = "";
      rebuild();
      return { consume: true };
    }

    // Navigation keys are delegated to SelectList.
    if (/^\x1b\[[0-9;]*[ABCDHF~]$/.test(data) || /^\x1bO[A-H]$/.test(data)) {
      const before = list?.getSelectedItem?.()?.value;
      list?.handleInput?.(data);
      const after = list?.getSelectedItem?.()?.value;
      if (before !== after) selectedValue = after;
      tui.requestRender();
      return { consume: true };
    }

    const paste = extractPaste(data);
    if (paste !== null) {
      query += paste;
      rebuild();
      return { consume: true };
    }

    // Printable text (including multi-character paste) appends to the query.
    if (/^[\x20-\x7e]+$/.test(data)) {
      query += data;
      rebuild();
      return { consume: true };
    }
    return { consume: true };
  }

  const removeListener = tui.addInputListener(onKey);

  function close(): void {
    if (closed) return;
    closed = true;
    removeListener();
    container.removeChild(wrapper);
    wrapper.clear();
    restoreFocus?.();
    tui.requestRender();
  }

  renderFilter();
  rebuild();

  return {
    updateItems(next: PickerItem[]): void {
      if (closed) return;
      allItems = next;
      // Keep the highlighted item stable across a live model refresh.
      selectedValue = list?.getSelectedItem?.()?.value ?? selectedValue;
      rebuild();
    },
    setStatus(status: string): void {
      if (closed) return;
      statusText.setText(status ? `${DIM}${status}${RESET}` : "");
      tui.requestRender();
    },
    close,
  };
}
