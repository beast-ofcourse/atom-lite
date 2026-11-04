import {
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  isKeyRelease,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { extractPaste } from "./input.js";
import { darkTheme, type Theme } from "./theme.js";

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
  /** Value to highlight when the picker opens. */
  initialValue?: string;
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
  /** Close before onSelect (default true). Set false for toggle items. */
  closeOnSelect?: boolean;
  /** Called as the highlighted item changes, for live previews. */
  onPreview?: (item: PickerItem) => void;
  restoreFocus?: () => void;
  theme?: Theme;
}

export interface SearchablePicker {
  /** Replace the full item set (e.g. after live model discovery). */
  updateItems(items: PickerItem[]): void;
  /** Update the dim status line under the title. */
  setStatus(status: string): void;
  close(): void;
}

/** Fuzzy-filter picker items on label, description and value. */
export function filterPickerItems(
  items: PickerItem[],
  query: string,
): PickerItem[] {
  const q = query.trim();
  if (!q) return items;
  return fuzzyFilter(
    items,
    q,
    (item) => `${item.label} ${item.description ?? ""} ${item.value}`,
  );
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
    initialValue,
    onSelect,
    onCancel,
    onPreview,
    restoreFocus,
  } = options;
  const closeOnSelect = options.closeOnSelect ?? true;
  const theme = options.theme ?? darkTheme;
  const selectListTheme = {
    selectedPrefix: (s: string) => theme.tokens.accent(s),
    selectedText: (s: string) => theme.tokens.selection(s),
    description: (s: string) => theme.tokens.dim(s),
    scrollInfo: (s: string) => theme.tokens.dim(s),
    noMatch: (s: string) => theme.tokens.dim(s),
  };

  let allItems = initialItems;
  let query = initialQuery;
  let closed = false;
  let selectedValue: string | undefined = initialValue;

  const wrapper = new Container();
  const titleText = new Text(theme.tokens.accent(title));
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
    filterText.setText(
      query
        ? `${theme.tokens.dim("search:")} ${query}${theme.tokens.accent("▏")}`
        : theme.tokens.dim("type to search…"),
    );
  }

  function rebuild(): void {
    const filtered = filterPickerItems(allItems, query);
    listHost.clear();
    if (filtered.length === 0) {
      list = null;
      listHost.addChild(
        new Text(theme.tokens.dim(`  no models match “${query}”`)),
      );
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
      if (closeOnSelect) close();
      onSelect(item);
    };
    list.onCancel = () => {
      close();
      onCancel();
    };
    if (onPreview) {
      list.onSelectionChange = (item: any) => onPreview(item);
    }
    listHost.addChild(list);
    renderFilter();
    tui.requestRender();
  }

  function onKey(data: string): any {
    if (closed) return { consume: true };
    // Kitty reports key releases (and, with some terminals, repeats). Releases
    // must never trigger an action, or every keystroke fires twice.
    if (isKeyRelease(data)) return { consume: true };

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      close();
      onCancel();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      const item = list?.getSelectedItem?.();
      if (item) {
        selectedValue = item.value;
        if (closeOnSelect) close();
        onSelect(item);
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.backspace)) {
      query = query.slice(0, -1);
      rebuild();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      query = "";
      rebuild();
      return { consume: true };
    }

    // Navigation keys are delegated to SelectList, which understands both
    // legacy sequences and Kitty CSI-u / event-type encodings.
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.pageDown)
    ) {
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

    // Kitty flag 1 sends printable keys as CSI-u sequences; decode those
    // before falling back to plain printable text and pastes.
    const kittyChar = decodeKittyPrintable(data);
    if (kittyChar !== undefined) {
      query += kittyChar;
      rebuild();
      return { consume: true };
    }
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
      statusText.setText(status ? theme.tokens.dim(status) : "");
      tui.requestRender();
    },
    close,
  };
}
