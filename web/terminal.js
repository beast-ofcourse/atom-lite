const MAX_SCROLLBACK = 60_000;
const RESIZE_DEBOUNCE_MS = 100;
const MEASURE_CHARS = 100;
const TAIL_TOLERANCE = 4;

const ANSI_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

const ANSI_PATTERN =
  /(\u001B\[([0-9;]*)m)|(\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[\u0040-\u005F]|\u009B[0-9;?]*[ -/]*[@-~])/g;

const REFUSAL_TYPES = new Set(["terminal_refused", "terminal_error", "error"]);

const CONTROL_KEYS = {
  ArrowUp: "\u001B[A",
  ArrowDown: "\u001B[B",
  ArrowRight: "\u001B[C",
  ArrowLeft: "\u001B[D",
  Home: "\u001B[H",
  End: "\u001B[F",
  PageUp: "\u001B[5~",
  PageDown: "\u001B[6~",
  Delete: "\u001B[3~",
};

let terminalCounter = 0;

function defaultStyle() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    hidden: false,
  };
}

function color256(index) {
  if (!Number.isInteger(index) || index < 0) return null;
  if (index < 16) return ANSI_COLORS[index];
  if (index < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const level = index - 16;
    const r = levels[Math.floor(level / 36) % 6];
    const g = levels[Math.floor(level / 6) % 6];
    const b = levels[level % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const gray = Math.min(255, 8 + (index - 232) * 10);
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applySgr(style, codes) {
  const next = { ...style };
  const params = (codes === "" ? "0" : codes)
    .split(";")
    .map((value) => (value === "" ? 0 : Number(value)));

  for (let i = 0; i < params.length; i += 1) {
    const code = params[i];
    if (code === 0) Object.assign(next, defaultStyle());
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 21 || code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && params.length > i + 2) {
        next[target] = color256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2 && params.length > i + 4) {
        next[target] =
          `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`;
        i += 4;
      }
    }
  }
  return next;
}

function sameStyle(a, b) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden
  );
}

export function parseAnsi(data) {
  const segments = [];
  let style = defaultStyle();
  let cursor = 0;
  let match;

  ANSI_PATTERN.lastIndex = 0;
  while ((match = ANSI_PATTERN.exec(data)) !== null) {
    if (match.index > cursor) {
      const previous = segments[segments.length - 1];
      const text = data.slice(cursor, match.index);
      if (previous && sameStyle(previous.style, style)) previous.text += text;
      else segments.push({ text, style });
    }
    if (match[1]) style = applySgr(style, match[2]);
    cursor = match.index + match[0].length;
  }
  if (cursor < data.length) {
    const previous = segments[segments.length - 1];
    const text = data.slice(cursor);
    if (previous && sameStyle(previous.style, style)) previous.text += text;
    else segments.push({ text, style });
  }

  return segments.map(({ text, style }) => ({ text, ...style }));
}

function cssColor(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === "number" ? ANSI_COLORS[value] : value;
}

function renderSegment(segment) {
  const styled =
    segment.fg !== null ||
    segment.bg !== null ||
    segment.bold ||
    segment.dim ||
    segment.italic ||
    segment.underline ||
    segment.strike ||
    segment.inverse ||
    segment.hidden;

  if (!styled) return document.createTextNode(segment.text);

  const span = document.createElement("span");
  span.className = "terminal-segment";
  if (segment.bold) span.classList.add("terminal-bold");
  if (segment.dim) span.classList.add("terminal-dim");
  if (segment.italic) span.classList.add("terminal-italic");
  if (segment.underline) span.classList.add("terminal-underline");
  if (segment.strike) span.classList.add("terminal-strike");
  if (segment.hidden) span.classList.add("terminal-hidden");

  if (segment.inverse) {
    span.style.color = cssColor(segment.bg, "var(--terminal-default-bg)");
    span.style.backgroundColor = cssColor(
      segment.fg,
      "var(--terminal-default-fg)",
    );
  } else {
    if (segment.fg !== null) span.style.color = cssColor(segment.fg, "");
    if (segment.bg !== null)
      span.style.backgroundColor = cssColor(segment.bg, "");
  }

  span.textContent = segment.text;
  return span;
}

function refusalText(message) {
  const raw = message.message ?? message.error ?? message.reason;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.toLowerCase();
  if (
    value.includes("read-only") ||
    value.includes("read only") ||
    value.includes("readonly") ||
    value.includes("read_only")
  ) {
    return "Terminal is unavailable in read-only mode.";
  }
  if (value.includes("plan")) return "Terminal is unavailable in plan mode.";
  return raw;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createTerminalId() {
  terminalCounter += 1;
  return (
    globalThis.crypto?.randomUUID?.() ??
    `terminal-${Date.now()}-${terminalCounter}`
  );
}

function createTerminalPane(deps, tab) {
  const terminalId =
    typeof tab?.terminalId === "string" && tab.terminalId
      ? tab.terminalId
      : createTerminalId();
  const root = element("div", "terminal-pane");
  root.dataset.terminalId = terminalId;

  const header = element("div", "terminal-header");
  const name = element("span", "terminal-name", tab?.title || "Terminal");
  const idLabel = element("span", "terminal-id", terminalId.slice(0, 8));
  const status = element("span", "terminal-status", "Connecting…");
  header.append(name, idLabel, status);

  const output = element("div", "terminal-output");
  output.setAttribute("role", "log");
  output.setAttribute("aria-live", "polite");
  output.setAttribute("aria-label", `${name.textContent} output`);
  output.tabIndex = 0;

  const measure = element(
    "span",
    "terminal-measure",
    "0".repeat(MEASURE_CHARS),
  );
  measure.setAttribute("aria-hidden", "true");
  output.append(measure);

  const inputRow = element("div", "terminal-input-row");
  const prompt = element("span", "terminal-prompt", "$");
  const input = element("input", "terminal-input");
  input.type = "text";
  input.disabled = true;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Terminal input");
  inputRow.append(prompt, input);
  root.append(header, output, inputRow);

  const chunks = [];
  let charCount = 0;
  let started = false;
  let everStarted = false;
  let destroyed = false;
  let follow = true;
  let resizeTimer = null;

  function isAtTail() {
    return (
      output.scrollHeight - output.scrollTop - output.clientHeight <=
      TAIL_TOLERANCE
    );
  }

  function scrollToBottom() {
    output.scrollTop = output.scrollHeight;
  }

  function trimScrollback() {
    while (charCount > MAX_SCROLLBACK && chunks.length > 0) {
      const first = chunks[0];
      const excess = charCount - MAX_SCROLLBACK;
      if (first.text.length <= excess) {
        first.node.remove();
        charCount -= first.text.length;
        chunks.shift();
      } else {
        first.text = first.text.slice(excess);
        first.node.textContent = first.text;
        charCount -= excess;
      }
    }
  }

  function appendNotice(text, tone) {
    const notice = element(
      "div",
      `terminal-notice terminal-notice-${tone}`,
      text,
    );
    output.append(notice);
    chunks.push({ node: notice, text });
    charCount += text.length;
    trimScrollback();
    scrollToBottom();
  }

  function appendOutput(data) {
    if (data === "") return;
    const shouldFollow = follow && isAtTail();
    let added = 0;
    for (const segment of parseAnsi(data)) {
      const node = renderSegment(segment);
      output.append(node);
      chunks.push({ node, text: segment.text });
      added += segment.text.length;
    }
    charCount += added;
    trimScrollback();
    if (shouldFollow && follow) scrollToBottom();
  }

  function sendResize() {
    if (!started || destroyed) return;
    const style = getComputedStyle(output);
    const charWidth = measure.getBoundingClientRect().width / MEASURE_CHARS;
    const fontSize = parseFloat(style.fontSize) || 13;
    const padX =
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0);
    const padY =
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0);
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.4;
    const cols = Math.max(
      1,
      Math.floor((output.clientWidth - padX) / (charWidth || fontSize * 0.6)),
    );
    const rows = Math.max(
      1,
      Math.floor((output.clientHeight - padY) / lineHeight),
    );
    deps.send({ type: "terminal_resize", id: terminalId, cols, rows });
  }

  function sendInput(data) {
    if (!started || destroyed || data === "") return;
    deps.send({ type: "terminal_input", id: terminalId, data });
  }

  function showRefusal(message) {
    const text = refusalText(message) ?? "The terminal could not be opened.";
    input.disabled = true;
    status.textContent = "Unavailable";
    appendNotice(text, "error");
    deps.toast?.(text, "warn");
  }

  function handleMessage(message) {
    if (
      destroyed ||
      !message ||
      typeof message !== "object" ||
      message.id !== terminalId
    )
      return;
    const type = message.type;

    if (type === "terminal_started") {
      if (message.error) {
        showRefusal(message);
        return;
      }
      started = true;
      everStarted = true;
      input.disabled = false;
      status.textContent = "Running";
      sendResize();
      return;
    }

    if (type === "terminal_output") {
      appendOutput(typeof message.data === "string" ? message.data : "");
      return;
    }

    if (type === "terminal_exited") {
      started = false;
      input.disabled = true;
      const code = Number.isInteger(message.code) ? ` ${message.code}` : "";
      status.textContent = `Exited${code}`;
      if (!everStarted) showRefusal(message);
      else appendNotice(`Process exited${code}.`, "info");
      return;
    }

    if (
      REFUSAL_TYPES.has(type) ||
      typeof message.error === "string" ||
      (typeof message.reason === "string" && !everStarted)
    ) {
      showRefusal(message);
    }
  }

  function onScroll() {
    follow = isAtTail();
  }

  function onOutputClick() {
    if (document.getSelection()?.toString()) return;
    input.focus();
  }

  function onKeyDown(event) {
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      const control = { c: "\u0003", d: "\u0004", l: "\u000c" }[key];
      if (control) {
        sendInput(control);
        event.preventDefault();
        input.value = "";
        follow = true;
        scrollToBottom();
        return;
      }
    }

    let data = null;
    if (event.key === "Enter") data = "\r";
    else if (event.key === "Backspace") data = "\u007F";
    else if (event.key === "Tab") data = "\t";
    else if (event.key === "Escape") data = "\u001B";
    else if (CONTROL_KEYS[event.key]) data = CONTROL_KEYS[event.key];
    else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    )
      data = event.key;

    if (data !== null) {
      sendInput(data);
      event.preventDefault();
      input.value = "";
      follow = true;
      scrollToBottom();
    }
  }

  function onPaste(event) {
    const data = event.clipboardData?.getData("text");
    if (!data) return;
    event.preventDefault();
    input.value = "";
    sendInput(data);
    follow = true;
    scrollToBottom();
  }

  const unsubscribe = deps.onSocket(handleMessage);
  const observer = new ResizeObserver(() => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      sendResize();
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(output);

  output.addEventListener("scroll", onScroll);
  output.addEventListener("click", onOutputClick);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("paste", onPaste);

  deps.send({ type: "terminal_open", id: terminalId });

  return {
    element: root,
    focus() {
      input.focus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      output.removeEventListener("scroll", onScroll);
      output.removeEventListener("click", onOutputClick);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("paste", onPaste);
      deps.send({ type: "terminal_close", id: terminalId });
      root.remove();
    },
  };
}

export function registerTerminal(deps) {
  deps.registerTabType("terminal", (paneDeps, tab) =>
    createTerminalPane(paneDeps, tab),
  );
}
