import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeyId,
} from "@earendil-works/pi-tui";

/**
 * Extra editor keybindings for the prompt input. pi-tui's global
 * KeybindingsManager replaces an action's defaults when user bindings are
 * supplied for it, so the defaults are restated here and the new keys are
 * appended:
 *
 * - ctrl+backspace        delete the word left of the cursor
 * - ctrl+shift+backspace  delete the whole current line
 *
 * ctrl+backspace is only produced by terminals that enable the Kitty
 * keyboard protocol (CSI-u) or modifyOtherKeys; the legacy defaults
 * (ctrl+w / alt+backspace, ctrl+u) cover everywhere else.
 */
export const EDITOR_KEYBINDINGS: Record<string, KeyId[]> = {
  "tui.editor.deleteWordBackward": [
    "ctrl+w",
    "alt+backspace",
    "ctrl+backspace",
  ],
  "tui.editor.deleteToLineStart": ["ctrl+u", "ctrl+shift+backspace"],
};

/** Install EDITOR_KEYBINDINGS into pi-tui's global registry. */
export function installEditorKeybindings(): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, EDITOR_KEYBINDINGS));
}
