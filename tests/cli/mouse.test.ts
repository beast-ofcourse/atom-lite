import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockAtLine,
  blockAtScreenRow,
  createMouseCapture,
  handleMouseEvent,
  MOUSE_SCROLL_LINES,
  mouseCaptureSequence,
  parseSgrMouse,
  shouldEnableMouse,
} from "../../dist/cli/mouse.js";

test("parses SGR wheel events and converts to zero-based coordinates", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<64;10;5M"), {
    type: "wheel",
    direction: "up",
    x: 9,
    y: 4,
  });
  assert.deepEqual(parseSgrMouse("\x1b[<65;1;1M"), {
    type: "wheel",
    direction: "down",
    x: 0,
    y: 0,
  });
});

test("parses press and release for each SGR button", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;2;3M"), {
    type: "press",
    button: "left",
    x: 1,
    y: 2,
  });
  assert.deepEqual(parseSgrMouse("\x1b[<0;2;3m"), {
    type: "release",
    button: "left",
    x: 1,
    y: 2,
  });
  assert.equal(parseSgrMouse("\x1b[<2;2;3M")?.button, "right");
  assert.equal(parseSgrMouse("\x1b[<1;2;3M")?.button, "middle");
});

test("ignores wheel releases and non-mouse input", () => {
  assert.equal(parseSgrMouse("\x1b[<64;10;5m"), undefined);
  assert.equal(parseSgrMouse("\x1b[A"), undefined);
  assert.equal(parseSgrMouse("hello"), undefined);
});

test("hit-tests document lines across blocks", () => {
  const blocks = [
    { id: "header", height: 2 },
    { id: "tools", height: 3 },
  ];
  assert.deepEqual(blockAtLine(blocks, 0), { id: "header", offset: 0 });
  assert.deepEqual(blockAtLine(blocks, 1), { id: "header", offset: 1 });
  assert.deepEqual(blockAtLine(blocks, 2), { id: "tools", offset: 0 });
  assert.deepEqual(blockAtLine(blocks, 4), { id: "tools", offset: 2 });
  assert.equal(blockAtLine(blocks, 5), undefined);
  assert.equal(blockAtLine(blocks, -1), undefined);
});

test("screen rows map to the tail of the rendered document", () => {
  const blocks = [
    { id: "header", height: 2 },
    { id: "tools", height: 3 },
  ];
  // Five document lines in a three-row terminal: rows 0-2 show lines 2-4.
  assert.deepEqual(blockAtScreenRow(blocks, 0, 3), { id: "tools", offset: 0 });
  assert.deepEqual(blockAtScreenRow(blocks, 2, 3), { id: "tools", offset: 2 });
  assert.deepEqual(blockAtScreenRow(blocks, 0, 10), {
    id: "header",
    offset: 0,
  });
});

function harness(overrides: Partial<Parameters<typeof handleMouseEvent>[1]> = {}) {
  const calls: string[] = [];
  const handlers = {
    isModalOpen: () => false,
    scrollBy: (lines: number) => calls.push(`scroll:${lines}`),
    focusInput: () => calls.push("focus"),
    toggleToolBox: (screenY: number) => {
      calls.push(`tool:${screenY}`);
      return false;
    },
    requestRender: () => calls.push("render"),
    ...overrides,
  };
  return { calls, handlers };
}

test("wheel scrolls the transcript", () => {
  const { calls, handlers } = harness();
  handleMouseEvent({ type: "wheel", direction: "up", x: 0, y: 0 }, handlers);
  handleMouseEvent({ type: "wheel", direction: "down", x: 0, y: 0 }, handlers);
  assert.deepEqual(calls, [
    `scroll:${-MOUSE_SCROLL_LINES}`,
    "render",
    `scroll:${MOUSE_SCROLL_LINES}`,
    "render",
  ]);
});

test("left click toggles a tool box and otherwise focuses the input", () => {
  const toolHarness = harness({
    toggleToolBox: (screenY: number) => {
      toolHarness.calls.push(`tool:${screenY}`);
      return true;
    },
  });
  handleMouseEvent(
    { type: "press", button: "left", x: 0, y: 4 },
    toolHarness.handlers,
  );
  assert.deepEqual(toolHarness.calls, ["tool:4", "render"]);

  const inputHarness = harness();
  handleMouseEvent(
    { type: "press", button: "left", x: 0, y: 4 },
    inputHarness.handlers,
  );
  assert.deepEqual(inputHarness.calls, ["tool:4", "focus", "render"]);
});

test("mouse events are ignored while a modal is open", () => {
  const { calls, handlers } = harness({ isModalOpen: () => true });
  assert.equal(
    handleMouseEvent(
      { type: "press", button: "left", x: 0, y: 4 },
      handlers,
    ),
    true,
  );
  assert.equal(
    handleMouseEvent({ type: "wheel", direction: "down", x: 0, y: 0 }, handlers),
    true,
  );
  assert.deepEqual(calls, []);
});

test("capture is enabled only for interactive TTY sessions with ui.mouse", () => {
  assert.equal(
    shouldEnableMouse({
      interactive: true,
      configured: true,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    shouldEnableMouse({
      interactive: false,
      configured: true,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    shouldEnableMouse({
      interactive: true,
      configured: false,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    shouldEnableMouse({
      interactive: true,
      configured: true,
      stdoutIsTTY: false,
    }),
    false,
  );
});

test("capture sequences turn tracking on and off symmetrically", () => {
  const writes: string[] = [];
  const capture = createMouseCapture((data) => writes.push(data));
  capture.enable();
  capture.disable();
  assert.deepEqual(writes, [
    mouseCaptureSequence(true),
    mouseCaptureSequence(false),
  ]);
  assert.match(mouseCaptureSequence(true), /1000h/);
  assert.match(mouseCaptureSequence(true), /1006h/);
  assert.match(mouseCaptureSequence(false), /1000l/);
  assert.match(mouseCaptureSequence(false), /1006l/);
});
