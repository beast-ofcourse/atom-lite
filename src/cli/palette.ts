import {
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  Text,
} from "@earendil-works/pi-tui";
import { extractPaste } from "./input.js";
import { darkTheme, type Theme } from "./theme.js";

export interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  /** Extra fuzzy-search terms (for example command aliases). */
  keywords?: string[];
  action: () => void | Promise<void>;
}

export interface PaletteGroup {
  category: string;
  items: PaletteItem[];
}

/** Fuzzy-filter palette items on label, description, category and keywords. */
export function filterPaletteItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const q = query.trim();
  if (!q) return items;
  return fuzzyFilter(items, q, (item) =>
    [
      item.label,
      item.description ?? "",
      item.category,
      ...(item.keywords ?? []),
    ].join(" "),
  );
}

/**
 * Group items by category, keeping the category order of first appearance.
 * Filtering happens first, so groups only contain matching items.
 */
export function groupPaletteItems(items: PaletteItem[]): PaletteGroup[] {
  const groups = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return [...groups].map(([category, grouped]) => ({
    category,
    items: grouped,
  }));
}

function flatten(groups: PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((group) => group.items);
}

export interface CommandPaletteOptions {
  tui: any;
  container: any;
  items: PaletteItem[];
  maxVisible?: number;
  title?: string;
  theme?: Theme;
  onCancel?: () => void;
  /** Called after the palette closes and focus is restored, before the action. */
  onSelect?: (item: PaletteItem) => void;
  onError?: (error: unknown) => void;
  restoreFocus?: () => void;
}

export interface CommandPalette {
  updateItems(items: PaletteItem[]): void;
  close(): void;
  get isOpen(): boolean;
}

/** Open the ctrl+p command palette overlay. */
export function openCommandPalette(
  options: CommandPaletteOptions,
): CommandPalette {
  const {
    tui,
    container,
    items: initialItems,
    maxVisible = 12,
    title = "Command palette",
    onCancel,
    onSelect,
    onError,
    restoreFocus,
  } = options;

  let allItems = initialItems;
  let query = "";
  let closed = false;
  let selectedId: string | undefined;
  let flat: PaletteItem[] = [];
  const theme = options.theme ?? darkTheme;

  const wrapper = new Container();
  const titleText = new Text(theme.tokens.accent(title));
  const filterText = new Text("");
  const listText = new Text("");
  wrapper.addChild(titleText);
  wrapper.addChild(filterText);
  wrapper.addChild(listText);
  container.addChild(wrapper);

  function renderFilter(): void {
    filterText.setText(
      query
        ? `${theme.tokens.dim("search:")} ${query}${theme.tokens.accent("▏")}`
        : theme.tokens.dim("type to search…"),
    );
  }

  function renderList(): void {
    const filtered = filterPaletteItems(allItems, query);
    const groups = groupPaletteItems(filtered);
    flat = flatten(groups);

    if (flat.length === 0) {
      selectedId = undefined;
      listText.setText(theme.tokens.dim("  no commands match"));
      return;
    }

    if (!selectedId || !flat.some((item) => item.id === selectedId)) {
      selectedId = flat[0].id;
    }
    const selectedIndex = Math.max(
      0,
      flat.findIndex((item) => item.id === selectedId),
    );
    const windowSize = Math.max(1, maxVisible);
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(windowSize / 2)),
      Math.max(0, flat.length - windowSize),
    );
    const end = start + windowSize;

    const lines: string[] = [];
    for (const group of groups) {
      const visible = group.items.filter((item) => {
        const index = flat.indexOf(item);
        return index >= start && index < end;
      });
      if (visible.length === 0) continue;
      lines.push(theme.tokens.dim(`── ${group.category} ──`));
      for (const item of visible) {
        const selected = item.id === selectedId;
        const hint = item.description
          ? theme.tokens.dim(`  ${item.description}`)
          : "";
        const label = `${selected ? "▸ " : "  "}${item.label}`;
        lines.push(
          selected ? theme.tokens.selection(label) + hint : label + hint,
        );
      }
    }
    if (flat.length > windowSize) {
      lines.push(
        theme.tokens.dim(
          `  ${selectedIndex + 1}/${flat.length} · ↑/↓ to move · Esc to cancel`,
        ),
      );
    }
    listText.setText(lines.join("\n"));
  }

  function rebuild(): void {
    renderFilter();
    renderList();
    tui.requestRender();
  }

  function move(delta: number): void {
    if (flat.length === 0) return;
    const current = Math.max(
      0,
      flat.findIndex((item) => item.id === selectedId),
    );
    const next = Math.min(flat.length - 1, Math.max(0, current + delta));
    selectedId = flat[next].id;
    renderList();
    tui.requestRender();
  }

  function onKey(data: string): any {
    if (closed) return { consume: true };
    if (isKeyRelease(data)) return { consume: true };

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      close();
      onCancel?.();
      return { consume: true };
    }
    // ctrl+p toggles the palette closed, matching the key that opened it.
    if (matchesKey(data, Key.ctrl("p")) && !isKeyRepeat(data)) {
      close();
      onCancel?.();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      const item = flat.find((entry) => entry.id === selectedId);
      if (item) void run(item);
      return { consume: true };
    }
    if (matchesKey(data, Key.up)) {
      move(-1);
      return { consume: true };
    }
    if (matchesKey(data, Key.down)) {
      move(1);
      return { consume: true };
    }
    if (matchesKey(data, Key.pageUp)) {
      move(-10);
      return { consume: true };
    }
    if (matchesKey(data, Key.pageDown)) {
      move(10);
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

    const paste = extractPaste(data);
    if (paste !== null) {
      query += paste;
      rebuild();
      return { consume: true };
    }
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

  async function run(item: PaletteItem): Promise<void> {
    close();
    onSelect?.(item);
    try {
      await item.action();
    } catch (error) {
      onError?.(error);
    }
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

  rebuild();

  return {
    updateItems(next: PaletteItem[]): void {
      if (closed) return;
      allItems = next;
      rebuild();
    },
    close,
    get isOpen(): boolean {
      return !closed;
    },
  };
}
