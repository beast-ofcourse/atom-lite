import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

/**
 * Single-line input that never echoes its value. Used for API keys so secrets
 * do not land in terminal scrollback or TUI transcripts.
 */
export class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  private pasteBuffer: string | null = null;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(
    private readonly label = "API key",
    private readonly placeholder = "paste key (input hidden)",
  ) {}

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
  }

  reset(): void {
    this.value = "";
    this.pasteBuffer = null;
  }

  invalidate(): void {
    // No cached render state.
  }

  handleInput(data: string): void {
    if (this.pasteBuffer !== null) {
      const end = data.indexOf("\x1b[201~");
      if (end === -1) {
        this.pasteBuffer += data;
        return;
      }
      this.pasteBuffer += data.slice(0, end);
      this.value += this.pasteBuffer.replace(/[\x00-\x1f]/g, "");
      this.pasteBuffer = null;
      return;
    }
    const pasteStart = data.indexOf("\x1b[200~");
    if (pasteStart !== -1) {
      const after = data.slice(pasteStart + 6);
      const end = after.indexOf("\x1b[201~");
      if (end === -1) {
        this.pasteBuffer = after;
      } else {
        this.value += after.slice(0, end).replace(/[\x00-\x1f]/g, "");
      }
      return;
    }

    if (isKeyRelease(data)) return;

    if (matchesKey(data, Key.enter)) {
      this.onSubmit?.(this.value.trim());
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.value = "";
      return;
    }
    if (matchesKey(data, Key.ctrl("w"))) {
      this.value = this.value.replace(/\s*\S+\s*$/, "");
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.value = this.value.slice(0, -1);
      return;
    }

    // Kitty flag 1 sends printable keys as CSI-u sequences.
    const kittyChar = decodeKittyPrintable(data);
    if (kittyChar !== undefined) {
      this.value += kittyChar;
      return;
    }

    // Drop escape sequences (arrow keys, kitty key events) and control chars.
    const cleaned = data
      .replace(/\x1b\[[0-9;:?]*[A-Za-z~]/g, "")
      .replace(/\x1bO[A-Za-z]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, "");
    if (cleaned) this.value += cleaned;
  }

  render(width: number): string[] {
    const masked = "•".repeat(
      Math.min(this.value.length, Math.max(0, width - 20)),
    );
    const shown = this.value ? masked : `${DIM}${this.placeholder}${RESET}`;
    const marker = this.focused ? CURSOR_MARKER : "";
    return [` ${CYAN}${this.label}:${RESET} ${shown}${marker}`];
  }
}
