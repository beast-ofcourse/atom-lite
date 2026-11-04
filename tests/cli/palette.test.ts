import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterPaletteItems,
  groupPaletteItems,
  openCommandPalette,
  type PaletteItem,
} from "../../dist/cli/palette.js";

function items(): PaletteItem[] {
  return [
    {
      id: "command:help",
      label: "/help",
      description: "show commands",
      category: "General",
      action: () => {},
    },
    {
      id: "command:theme",
      label: "/theme",
      description: "choose a colour theme",
      category: "Appearance",
      action: () => {},
    },
    {
      id: "theme:dark",
      label: "dark",
      description: "dark theme",
      category: "Themes",
      action: () => {},
    },
    {
      id: "skill:review",
      label: "review",
      description: "review code",
      category: "Skills",
      action: () => {},
    },
  ];
}

function harness() {
  const listeners: ((data: string) => unknown)[] = [];
  let focusCount = 0;
  const tui = {
    addInputListener(fn: (data: string) => unknown) {
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    requestRender() {},
  };
  const container = {
    added: [] as unknown[],
    addChild(child: unknown) {
      this.added.push(child);
    },
    removeChild() {},
  };
  return {
    tui,
    container,
    restoreFocus: () => {
      focusCount++;
    },
    get focusCount() {
      return focusCount;
    },
    send(data: string) {
      for (const fn of [...listeners]) fn(data);
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

test("palette fuzzy-filters on label, description and category", () => {
  const matches = filterPaletteItems(items(), "colour");
  assert.deepEqual(
    matches.map((item) => item.id),
    ["command:theme"],
  );
});

test("palette groups items by category in first-seen order", () => {
  const groups = groupPaletteItems(items());
  assert.deepEqual(
    groups.map((group) => group.category),
    ["General", "Appearance", "Themes", "Skills"],
  );
  assert.equal(groups[1].items[0].id, "command:theme");
});

test("Enter runs the selected item's action and restores focus", async () => {
  const h = harness();
  let ran = "";
  let selected = "";
  const all = items();
  all[0].action = () => {
    ran = "help";
  };
  all[1].action = () => {
    ran = "theme";
  };
  const palette = openCommandPalette({
    tui: h.tui,
    container: h.container,
    items: all,
    onSelect: (item) => {
      selected = item.id;
    },
    restoreFocus: h.restoreFocus,
  });

  h.send("t");
  h.send("h");
  h.send("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ran, "theme");
  assert.equal(selected, "command:theme");
  assert.equal(h.focusCount, 1);
  assert.equal(palette.isOpen, false);
  assert.equal(h.listenerCount, 0);
});

test("Escape cancels without running an action and restores focus", async () => {
  const h = harness();
  let ran = false;
  let cancelled = false;
  const all = items();
  all[0].action = () => {
    ran = true;
  };
  openCommandPalette({
    tui: h.tui,
    container: h.container,
    items: all,
    onCancel: () => {
      cancelled = true;
    },
    restoreFocus: h.restoreFocus,
  });

  h.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ran, false);
  assert.equal(cancelled, true);
  assert.equal(h.focusCount, 1);
});

test("ctrl+p closes the open palette without running an action", async () => {
  const h = harness();
  let ran = false;
  let cancelled = false;
  const all = items();
  all[0].action = () => {
    ran = true;
  };
  const palette = openCommandPalette({
    tui: h.tui,
    container: h.container,
    items: all,
    onCancel: () => {
      cancelled = true;
    },
    restoreFocus: h.restoreFocus,
  });

  h.send("\x10");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ran, false);
  assert.equal(cancelled, true);
  assert.equal(palette.isOpen, false);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.focusCount, 1);
});

test("arrow keys move selection within the grouped list", async () => {
  const h = harness();
  let selected = "";
  const all = items().map((item) => ({
    ...item,
    action: () => {
      selected = item.id;
    },
  }));
  openCommandPalette({
    tui: h.tui,
    container: h.container,
    items: all,
    onSelect: (item) => {
      selected = item.id;
    },
    restoreFocus: () => {},
  });

  h.send("\x1b[B");
  h.send("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selected, "command:theme");
});
