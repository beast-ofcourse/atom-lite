export type MouseEvent =
  | {
      type: "wheel";
      direction: "up" | "down";
      x: number;
      y: number;
    }
  | {
      type: "press" | "release";
      button: "left" | "middle" | "right" | "none";
      x: number;
      y: number;
    };

/** SGR mouse reporting (1006): ESC [ < button ; x ; y M|m. */
export function parseSgrMouse(data: string): MouseEvent | undefined {
  const trimmed = data.trim();
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(trimmed);
  if (!match) return undefined;
  const code = Number(match[1]);
  const x = Math.max(0, Number(match[2]) - 1);
  const y = Math.max(0, Number(match[3]) - 1);
  const release = match[4] === "m";

  if ((code & 64) !== 0) {
    if (release) return undefined;
    const direction = (code & 1) === 0 ? "up" : "down";
    return { type: "wheel", direction, x, y };
  }

  const buttonCode = code & 3;
  const button =
    buttonCode === 0
      ? "left"
      : buttonCode === 1
        ? "middle"
        : buttonCode === 2
          ? "right"
          : "none";
  return { type: release ? "release" : "press", button, x, y };
}

export interface MouseBlock {
  id: string;
  height: number;
}

/** Find which block occupies a line, starting at the top of the document. */
export function blockAtLine(
  blocks: MouseBlock[],
  line: number,
): { id: string; offset: number } | undefined {
  if (line < 0) return undefined;
  let top = 0;
  for (const block of blocks) {
    if (line < top + block.height) {
      return { id: block.id, offset: line - top };
    }
    top += block.height;
  }
  return undefined;
}

/**
 * Map a terminal screen row (zero-based from the top) onto a document line.
 * The normal-screen renderer shows the tail of the document, so long
 * transcripts need the scrollback offset added.
 */
export function blockAtScreenRow(
  blocks: MouseBlock[],
  screenY: number,
  terminalRows: number,
): { id: string; offset: number } | undefined {
  const total = blocks.reduce((sum, block) => sum + block.height, 0);
  const viewportTop = Math.max(0, total - Math.max(0, terminalRows));
  return blockAtLine(blocks, viewportTop + Math.max(0, screenY));
}

export interface MouseHandlers {
  isModalOpen(): boolean;
  scrollBy(lines: number): void;
  focusInput(): void;
  /** Return true when the click hit a tool box and toggled it. */
  toggleToolBox(screenY: number): boolean;
  requestRender(): void;
}

export const MOUSE_SCROLL_LINES = 3;

/** Apply one normalized mouse event. Returns true when it was consumed. */
export function handleMouseEvent(
  event: MouseEvent,
  handlers: MouseHandlers,
): boolean {
  if (handlers.isModalOpen()) return true;
  if (event.type === "wheel") {
    handlers.scrollBy(
      event.direction === "up" ? -MOUSE_SCROLL_LINES : MOUSE_SCROLL_LINES,
    );
    handlers.requestRender();
    return true;
  }
  if (event.type === "press" && event.button === "left") {
    if (!handlers.toggleToolBox(event.y)) handlers.focusInput();
    handlers.requestRender();
    return true;
  }
  return event.type === "release";
}

/** Mouse capture on/off sequences for SGR-capable terminals. */
export function mouseCaptureSequence(enabled: boolean): string {
  return enabled
    ? "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h"
    : "\x1b[?1006l\x1b[?1004l\x1b[?1002l\x1b[?1000l";
}

export function shouldEnableMouse(options: {
  interactive: boolean;
  configured: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  return options.interactive && options.configured && options.stdoutIsTTY;
}

export interface MouseCapture {
  enable(): void;
  disable(): void;
}

export function createMouseCapture(
  write: (data: string) => void,
): MouseCapture {
  return {
    enable: () => write(mouseCaptureSequence(true)),
    disable: () => write(mouseCaptureSequence(false)),
  };
}
