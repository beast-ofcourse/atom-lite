import { test } from "node:test";
import assert from "node:assert/strict";
import { openSearchablePicker, type PickerItem } from "../../dist/cli/picker.js";

const ITEMS: PickerItem[] = [
  { value: "kilo\u0000kilo-auto/free", label: "kilo-auto/free", description: "Kilo" },
  { value: "openai\u0000gpt-4o-mini", label: "gpt-4o-mini", description: "OpenAI" },
  { value: "google\u0000gemini-2.5-flash", label: "gemini-2.5-flash", description: "Google" },
];

function harness() {
  const listeners: ((data: string) => unknown)[] = [];
  const tui = {
    addInputListener(fn: (data: string) => unknown) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    requestRender() {},
  };
  const container = {
    addChild() {},
    removeChild() {},
  };
  return {
    tui,
    container,
    send(data: string) {
      for (const fn of [...listeners]) fn(data);
    },
  };
}

test("picker moves with Kitty arrow press and ignores the release", () => {
  const h = harness();
  let picked: PickerItem | undefined;
  openSearchablePicker({
    tui: h.tui,
    container: h.container,
    title: "model",
    items: ITEMS,
    onSelect: (item) => (picked = item),
    onCancel: () => assert.fail("unexpected cancel"),
  });

  // Down press, then the matching release event, then Enter.
  h.send("\x1b[1;1:1B");
  h.send("\x1b[1;1:3B");
  h.send("\r");
  assert.equal(picked?.label, "gpt-4o-mini");
});

test("picker still supports legacy arrow sequences", () => {
  const h = harness();
  let picked: PickerItem | undefined;
  openSearchablePicker({
    tui: h.tui,
    container: h.container,
    title: "model",
    items: ITEMS,
    onSelect: (item) => (picked = item),
    onCancel: () => assert.fail("unexpected cancel"),
  });

  h.send("\x1b[B");
  h.send("\x1b[B");
  h.send("\r");
  assert.equal(picked?.label, "gemini-2.5-flash");
});

test("picker closes on Kitty and legacy Escape", () => {
  for (const escape of ["\x1b[27u", "\x1b"]) {
    const h = harness();
    let cancelled = false;
    openSearchablePicker({
      tui: h.tui,
      container: h.container,
      title: "model",
      items: ITEMS,
      onSelect: () => assert.fail("unexpected select"),
      onCancel: () => (cancelled = true),
    });
    h.send(escape);
    assert.equal(cancelled, true, `escape ${JSON.stringify(escape)}`);
  }
});

test("picker decodes Kitty printable keys into the search query", () => {
  const h = harness();
  let picked: PickerItem | undefined;
  openSearchablePicker({
    tui: h.tui,
    container: h.container,
    title: "model",
    items: ITEMS,
    onSelect: (item) => (picked = item),
    onCancel: () => assert.fail("unexpected cancel"),
  });

  // Kitty CSI-u for "gem".
  h.send("\x1b[103u");
  h.send("\x1b[101u");
  h.send("\x1b[109u");
  h.send("\r");
  assert.equal(picked?.label, "gemini-2.5-flash");
});
