import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  EDITOR_KEYBINDINGS,
  installEditorKeybindings,
} from "../../dist/cli/editor-keybindings.js";

test("ctrl+backspace resolves to delete-word-backward and ctrl+shift+backspace to line delete", () => {
  installEditorKeybindings();
  const kb = getKeybindings();
  // Kitty-protocol CSI-u sequences: codepoint 127 (backspace), modifiers
  // 5 = ctrl, 6 = ctrl+shift.
  assert.ok(
    kb.matches("\x1b[127;5u", "tui.editor.deleteWordBackward"),
    "ctrl+backspace deletes the word left of the cursor",
  );
  assert.ok(
    kb.matches("\x1b[127;6u", "tui.editor.deleteToLineStart"),
    "ctrl+shift+backspace deletes the whole line",
  );
  // Legacy defaults survive (terminals without kitty protocol).
  assert.ok(kb.matches("\x17", "tui.editor.deleteWordBackward"), "ctrl+w");
  assert.ok(kb.matches("\x15", "tui.editor.deleteToLineStart"), "ctrl+u");
});

test("new editor keybindings introduce no conflicts", () => {
  const manager = new KeybindingsManager(TUI_KEYBINDINGS, EDITOR_KEYBINDINGS);
  assert.deepEqual(manager.getConflicts(), []);
});
