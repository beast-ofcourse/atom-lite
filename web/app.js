// Browser client for the Atom-lite web surface.
//
// Protocol (JSON over WebSocket), mirrored by src/web/protocol.ts:
//   server -> hello | event | replay | turn_start | turn_stopping | turn_end
//             | input_queued | approval_request | sessions | session_changed
//             | workspace_changed | model_changed | runtime_state | models
//             | attachment | attachment_removed | skills | mcp
//             | directory | control | error
//   client -> input | stop | approval | list_sessions | new_session | resume_session
//             | rename_session | delete_session | switch_model
//             | browse_directory | switch_workspace | set_effort | set_mode
//             | refresh_models | attach_file | remove_attachment
//             | list_skills | list_mcp

import { buildDiffModel } from "./diff.js";

const TOKEN = window.__ATOM_TOKEN__ || "";
const transcriptEl = document.getElementById("transcript");
let renderTarget = transcriptEl;
const metaEl = document.getElementById("meta");
const modelNameEl = document.getElementById("model-name");
const roleEl = document.getElementById("role");
const sessionsEl = document.getElementById("sessions");
const sessionSearchEl = document.getElementById("session-search");
const newSessionEl = document.getElementById("new-session");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const sendIcon = sendEl.querySelector("use");
const queuedEl = document.getElementById("queued");
const suggestionsEl = document.getElementById("suggestions");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const sidebarScrim = document.getElementById("sidebar-scrim");
const approvalLayer = document.getElementById("approval-layer");
const approvalTool = document.getElementById("approval-tool");
const approvalCommand = document.getElementById("approval-command");
const approvalCwd = document.getElementById("approval-cwd");
const toastEl = document.getElementById("toast");
const modelButton = document.getElementById("model-button");
const modelModal = document.getElementById("model-modal");
const modelSearch = document.getElementById("model-search");
const modelRefresh = document.getElementById("model-refresh");
const modelList = document.getElementById("model-list");
const skillsModal = document.getElementById("skills-modal");
const skillsList = document.getElementById("skills-list");
const mcpModal = document.getElementById("mcp-modal");
const mcpList = document.getElementById("mcp-list");
const attachButton = document.getElementById("attach-button");
const fileInput = document.getElementById("file-input");
const attachmentsEl = document.getElementById("attachments");
const workspacePathEl = document.getElementById("workspace-path");
const workspacePathText = document.getElementById("workspace-path-text");
const themeToggle = document.getElementById("theme-toggle");
const themeMenu = document.getElementById("theme-menu");
const sessionMenu = document.getElementById("session-menu");
const slashMenu = document.getElementById("slash-menu");
const renameModal = document.getElementById("rename-modal");
const renameForm = document.getElementById("rename-form");
const renameInput = document.getElementById("rename-input");
const deleteModal = document.getElementById("delete-modal");
const deleteDesc = document.getElementById("delete-desc");
const deleteConfirm = document.getElementById("delete-confirm");
const workspaceModal = document.getElementById("workspace-modal");
const workspacePathInput = document.getElementById("workspace-path-input");
const workspaceUp = document.getElementById("workspace-up");
const workspaceGo = document.getElementById("workspace-go");
const dirList = document.getElementById("dir-list");
const workspaceUse = document.getElementById("workspace-use");
const paletteModal = document.getElementById("palette-modal");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
const effortButton = document.getElementById("effort-button");
const effortLabel = document.getElementById("effort-label");
const effortMenu = document.getElementById("effort-menu");
const modeButton = document.getElementById("mode-button");
const modeLabel = document.getElementById("mode-label");
const modeMenu = document.getElementById("mode-menu");
const imageModal = document.getElementById("image-modal");
const imagePreview = document.getElementById("image-preview");
const imageCaption = document.getElementById("image-caption");
const micButton = document.getElementById("mic-button");
const micIcon = micButton.querySelector("use");

// Tool cards cap the visible tail, like the terminal caps live output. The
// full text stays in the card's data until the card is rebuilt.
const MAX_TOOL_OUTPUT_CHARS = 60_000;
const MAX_TOOL_OUTPUT_LINES = 400;
const MAX_INPUT_HEIGHT = 200;
const SIDEBAR_KEY = "atom-lite.web.sidebar";
const STREAM_FRAME_MS = 48;
const STREAM_CHARS_PER_FRAME = 64;
const STREAM_FINAL_MULTIPLIER = 4;
const MARKDOWN_CACHE_LIMIT = 300;
const MARKDOWN_CACHE_MAX_CHARS = 20_000;
const HISTORY_PAGE_EVENTS = 80;

const hljs = window.hljs ?? null;
const markdown = window.markdownit
  ? window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
    })
  : null;

const mobileQuery = window.matchMedia("(max-width: 768px)");

let socket = null;
let readOnly = false;
let pendingApproval = null;
let lastApproval = null;
let assistantNode = null;
let thinkingNode = null;
let currentSessionId = null;
let sessionsCache = [];
let queuedMessages = [];
let approvalReturnFocus = null;
let toastTimer = null;
let currentProvider = "";
let currentModel = "";
let modelsCache = [];
let workspacePath = "";
let sessionMenuTarget = null;
let renameTargetId = null;
let deleteTargetId = null;
let directoryListing = null;
let modalReturnFocus = null;
let slashItems = [];
let slashIndex = 0;
let paletteItems = [];
let paletteIndex = 0;
let sessionRenderTimer = null;
let scrollFrame = null;
let themeMode = "system";
let currentEffort = "medium";
let currentMode = "yolo";
let mermaidPromise = null;
let mermaidSequence = 0;
let attachments = [];
const cancelledUploads = new Set();
let modelIndex = 0;
let pendingRename = null;
let pendingDelete = null;
let turnActive = false;
let viewToken = 0;
let stickToBottom = true;
const streamSinks = new WeakMap();
const toolCards = new Map();
const markdownCache = new Map();
let historyEvents = [];
let historyLimit = HISTORY_PAGE_EVENTS;

const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let listening = false;
let speechBase = "";
let speechFinal = "";
let speechInterim = "";

/* ---------------- icons ---------------- */

function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------------- storage, theme, popovers ---------------- */

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or disabled storage: the choice lasts for this page */
  }
}

function resolveTheme(mode) {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

function applyTheme(mode, persist = true) {
  themeMode = mode;
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
  if (persist) storageSet("atom-lite.web.theme", mode);
  const glyph = mode === "light" ? "sun" : mode === "dark" ? "moon" : "monitor";
  const use = themeToggle.querySelector("use");
  if (use) use.setAttribute("href", `#i-${glyph}`);
  themeToggle.setAttribute("aria-label", `Theme: ${mode} — change`);
  themeToggle.title = `Theme: ${mode}`;
  for (const item of themeMenu.querySelectorAll("[data-theme-mode]")) {
    item.setAttribute("aria-checked", String(item.dataset.themeMode === mode));
  }
  resetMermaidBlocks();
}

const storedTheme = storageGet("atom-lite.web.theme");
applyTheme(
  storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
    ? storedTheme
    : document.documentElement.dataset.theme === "light"
      ? "light"
      : "dark",
  false,
);
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (themeMode === "system") applyTheme("system", false);
  });

function allPopovers() {
  return [themeMenu, sessionMenu, slashMenu, effortMenu, modeMenu];
}

function closePopovers(except = null) {
  for (const popover of allPopovers()) {
    if (popover !== except && !popover.hidden) popover.hidden = true;
  }
  if (sessionMenuTarget && sessionMenu.hidden) {
    sessionMenuTarget.button
      ?.closest(".session-row")
      ?.classList.remove("menu-open");
    sessionMenuTarget = null;
  }
  themeToggle.setAttribute("aria-expanded", String(!themeMenu.hidden));
  effortButton.setAttribute("aria-expanded", String(!effortMenu.hidden));
  modeButton.setAttribute("aria-expanded", String(!modeMenu.hidden));
}

/** Position a popover next to an anchor, flipping above when needed. */
function placePopover(popover, anchor, preferAbove = false) {
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth || 240;
  const height = popover.offsetHeight || 180;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = preferAbove ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 6);
  }
  if (top < 8) top = Math.min(rect.bottom + 6, window.innerHeight - height - 8);
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}

/* ---------------- markdown ---------------- */

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function highlightCode(code, language) {
  if (!hljs || !language) return "";
  try {
    if (!hljs.getLanguage(language)) return "";
    return hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    }).value;
  } catch {
    // markdown-it escapes the code when highlighting returns nothing.
    return "";
  }
}

function renderFence(tokens, idx) {
  const token = tokens[idx];
  const info = (token.info ?? "").trim().split(/\s+/)[0] ?? "";
  const language = info || "text";
  if (info.toLowerCase() === "mermaid") {
    const source = escapeHtml(token.content);
    return (
      '<div class="mermaid-block" data-mermaid="' +
      source +
      '">' +
      '<div class="code-head">' +
      '<span class="code-lang">mermaid</span>' +
      '<button class="code-copy" type="button" data-code-copy>Copy</button>' +
      "</div>" +
      `<pre class="mermaid-source"><code>${source}</code></pre>` +
      "</div>"
    );
  }
  const highlighted = highlightCode(token.content, info);
  const code = highlighted || escapeHtml(token.content);
  return (
    '<div class="code-block">' +
    '<div class="code-head">' +
    `<span class="code-lang">${escapeHtml(language)}</span>` +
    '<button class="code-copy" type="button" data-code-copy>Copy</button>' +
    "</div>" +
    `<pre><code class="hljs">${code}</code></pre>` +
    "</div>"
  );
}

if (markdown) {
  const renderToken =
    markdown.renderer.rules.link_open ??
    ((tokens, idx, options, env, self) =>
      self.renderToken(tokens, idx, options));
  markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noreferrer noopener");
    return renderToken(tokens, idx, options, env, self);
  };
  const renderImage =
    markdown.renderer.rules.image ??
    ((tokens, idx, options, env, self) =>
      self.renderToken(tokens, idx, options));
  markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    if (src && !/^(https?:\/\/|data:|blob:)/i.test(src)) {
      const relative = src.replace(/^sandbox:\/?\/?/i, "");
      const local = `/image?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(relative)}`;
      token.attrSet("src", local);
    }
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    token.attrSet("referrerpolicy", "no-referrer");
    token.attrSet("class", "md-image");
    return renderImage(tokens, idx, options, env, self);
  };
  markdown.renderer.rules.fence = renderFence;
}

function renderMarkdown(text) {
  if (text.length > MARKDOWN_CACHE_MAX_CHARS) {
    return markdown
      ? markdown.render(text)
      : escapeHtml(text).replaceAll("\n", "<br>");
  }
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = markdown
    ? markdown.render(text)
    : escapeHtml(text).replaceAll("\n", "<br>");
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
    markdownCache.delete(markdownCache.keys().next().value);
  }
  markdownCache.set(text, html);
  return html;
}

/* ---------------- mermaid ---------------- */

function initializeMermaid(mermaid) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme:
      document.documentElement.dataset.theme === "light" ? "default" : "dark",
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
}

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/vendor/mermaid.min.js?token=${encodeURIComponent(TOKEN)}`;
      script.onload = () => {
        try {
          initializeMermaid(window.mermaid);
          resolve(window.mermaid);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => reject(new Error("mermaid failed to load"));
      document.head.append(script);
    }).catch((error) => {
      mermaidPromise = null;
      throw error;
    });
  }
  return mermaidPromise;
}

let mermaidObserver = null;

function renderMermaidBlock(block) {
  const source = block.dataset.mermaid ?? "";
  if (!source.trim() || block.dataset.rendering === "1" || !block.isConnected) {
    return;
  }
  block.dataset.rendering = "1";
  void loadMermaid()
    .then((mermaid) => {
      if (!block.isConnected) return;
      const id = `atom-mermaid-${++mermaidSequence}`;
      const result = mermaid.render(id, source);
      if (result && typeof result.then === "function") {
        void result
          .then((value) => applyMermaidSvg(block, value?.svg ?? value))
          .catch(() => {
            block.classList.add("failed");
            delete block.dataset.rendering;
          });
      } else {
        applyMermaidSvg(block, result?.svg ?? result);
      }
    })
    .catch(() => {
      if (!block.isConnected) return;
      block.classList.add("failed");
      delete block.dataset.rendering;
    });
}

function renderMermaidBlocks() {
  const blocks = [
    ...transcriptEl.querySelectorAll(
      ".mermaid-block:not([data-rendered]):not([data-rendering])",
    ),
  ];
  if (blocks.length === 0) return;
  if (!("IntersectionObserver" in window)) {
    for (const block of blocks) renderMermaidBlock(block);
    return;
  }
  if (!mermaidObserver) {
    mermaidObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          mermaidObserver.unobserve(entry.target);
          renderMermaidBlock(entry.target);
        }
      },
      { root: transcriptEl, rootMargin: "600px 0px" },
    );
  }
  for (const block of blocks) mermaidObserver.observe(block);
}

function applyMermaidSvg(block, svg) {
  if (!block.isConnected || typeof svg !== "string") return;
  block.querySelector(".mermaid-svg")?.remove();
  const holder = document.createElement("div");
  holder.className = "mermaid-svg";
  holder.innerHTML = svg;
  block.append(holder);
  block.dataset.rendered = "1";
  delete block.dataset.rendering;
  block.classList.add("rendered");
  block.classList.remove("failed");
}

function resetMermaidBlocks() {
  if (window.mermaid) initializeMermaid(window.mermaid);
  for (const block of transcriptEl.querySelectorAll(".mermaid-block")) {
    block.querySelector(".mermaid-svg")?.remove();
    delete block.dataset.rendered;
    delete block.dataset.rendering;
    block.classList.remove("rendered", "failed");
  }
  renderMermaidBlocks();
}

/**
 * Present text at a bounded pace without holding data hostage. Arrival is
 * immediate; only the visible tail is scheduled. A finalizing stream drains
 * faster so `turn_end` still settles quickly.
 */
function createPacedText({ onUpdate, onFinalize }) {
  let queue = [];
  let visible = "";
  let raw = "";
  let timer = null;
  let finalizing = false;
  let done = false;

  function schedule() {
    if (timer === null && queue.length > 0) {
      timer = setTimeout(drain, STREAM_FRAME_MS);
    }
  }

  function drain() {
    timer = null;
    const budget =
      STREAM_CHARS_PER_FRAME * (finalizing ? STREAM_FINAL_MULTIPLIER : 1);
    let remaining = budget;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.length <= remaining) {
        visible += head;
        queue.shift();
        remaining -= head.length;
      } else {
        visible += head.slice(0, remaining);
        queue[0] = head.slice(remaining);
        remaining = 0;
      }
    }
    onUpdate?.(visible);
    if (queue.length > 0) {
      schedule();
    } else if (finalizing) {
      finalizing = false;
      done = true;
      onFinalize?.(raw);
    }
  }

  return {
    push(text) {
      if (!text || done) return;
      raw += text;
      queue.push(text);
      schedule();
    },
    finalize() {
      if (done) return;
      finalizing = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (queue.length === 0) {
        done = true;
        onFinalize?.(raw);
        return;
      }
      drain();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue = [];
      visible = "";
      raw = "";
      finalizing = false;
      done = true;
    },
  };
}

/* ---------------- clipboard ---------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function flashCopy(button, doneIcon, doneLabel) {
  const use = button.querySelector("use");
  const previous = use?.getAttribute("href") ?? "";
  if (use && doneIcon) use.setAttribute("href", `#i-${doneIcon}`);
  button.classList.add("copied");
  const label = button.getAttribute("aria-label");
  if (doneLabel) button.setAttribute("aria-label", doneLabel);
  setTimeout(() => {
    if (use && previous) use.setAttribute("href", previous);
    button.classList.remove("copied");
    if (label) button.setAttribute("aria-label", label);
  }, 1200);
}

/* ---------------- home / empty state ---------------- */

function setHome(visible) {
  document.body.classList.toggle("is-empty", visible);
}

function syncSendState() {
  const running = turnActive && !readOnly;
  sendEl.disabled =
    readOnly ||
    attachments.some((item) => item.pending) ||
    (!running && inputEl.value.trim().length === 0);
  sendEl.classList.toggle("running", running);
  sendIcon?.setAttribute("href", running ? "#i-stop" : "#i-arrow-up");
  sendEl.setAttribute(
    "aria-label",
    running ? "Stop the agent" : "Send message",
  );
  sendEl.title = running ? "Stop the agent (Esc)" : "Send message";
  micButton.disabled = readOnly || !SpeechRecognitionCtor;
  micButton.classList.toggle("listening", listening);
  micIcon?.setAttribute("href", listening ? "#i-stop" : "#i-mic");
  micButton.setAttribute(
    "aria-label",
    listening ? "Stop voice input" : "Start voice input",
  );
  micButton.setAttribute("aria-pressed", String(listening));
  micButton.title = SpeechRecognitionCtor
    ? listening
      ? "Stop voice input"
      : "Voice input"
    : "Voice input unavailable in this browser";
}

function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

/* ---------------- rendering ---------------- */

/**
 * One central reset for every transcript view. Incrementing the token makes
 * queued stream frames and late event handlers from the outgoing session
 * inert before their DOM nodes are removed.
 */
function beginTranscriptView() {
  viewToken += 1;
  renderTarget = transcriptEl;
  cancelAssistantStream();
  if (thinkingNode) {
    streamSinks.get(thinkingNode)?.cancel();
    thinkingNode = null;
  }
  mermaidObserver?.disconnect();
  mermaidObserver = null;
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }
  closePopovers();
  transcriptEl.replaceChildren();
  toolCards.clear();
  setHome(true);
  clearQueued();
  stickToBottom = true;
  return viewToken;
}

function resetTranscript() {
  beginTranscriptView();
}

function clearQueued() {
  queuedMessages = [];
  renderQueued();
}

function renderQueued() {
  queuedEl.replaceChildren();
  if (queuedMessages.length === 0) {
    queuedEl.hidden = true;
    return;
  }
  queuedEl.hidden = false;
  for (const text of queuedMessages) {
    const item = document.createElement("div");
    item.className = "queued-item";
    const label = document.createElement("span");
    label.className = "queued-label";
    label.textContent = "Queued";
    item.append(label, document.createTextNode(` · ${text}`));
    queuedEl.append(item);
  }
}

/* ---------------- turn state ---------------- */

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function setTurnActive(active) {
  turnActive = active;
  syncSendState();
}

/** Ask the server to cancel the running turn. Returns false when idle. */
function stopAgent() {
  if (readOnly || !turnActive) return false;
  send({ type: "stop" });
  return true;
}

function textFromMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function addUserMessage(text, forceScroll = false) {
  setHome(false);
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = displayText(text);
  wrap.append(body);
  renderTarget.append(wrap);
  scrollToEnd(forceScroll);
}

function assistantBlock() {
  setHome(false);
  if (!assistantNode) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-assistant live";

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.append(icon("atom"));

    const content = document.createElement("div");
    content.className = "msg-content";

    const body = document.createElement("div");
    body.className = "msg-body msg-markdown streaming";
    body.dataset.raw = "";
    const token = viewToken;
    streamSinks.set(
      body,
      createPacedText({
        onUpdate(visible) {
          if (token !== viewToken || !body.isConnected) return;
          body.textContent = visible;
          scrollToEnd();
        },
        onFinalize(raw) {
          if (token !== viewToken || !body.isConnected) return;
          body.innerHTML = renderMarkdown(raw);
          body.classList.remove("streaming");
          wrap.classList.remove("live");
          renderMermaidBlocks();
          scrollToEnd();
        },
      }),
    );

    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn msg-copy";
    copy.setAttribute("aria-label", "Copy response");
    copy.append(icon("copy"));
    copy.addEventListener("click", async () => {
      const ok = await copyText(body.dataset.raw ?? body.textContent ?? "");
      if (ok) flashCopy(copy, "check", "Copied");
    });
    actions.append(copy);

    content.append(body, actions);
    wrap.append(avatar, content);
    renderTarget.append(wrap);
    assistantNode = body;
  }
  return assistantNode;
}

function appendAssistantText(text) {
  const body = assistantBlock();
  body.dataset.raw = (body.dataset.raw ?? "") + text;
  streamSinks.get(body)?.push(text);
}

function endAssistantBlock() {
  if (assistantNode) streamSinks.get(assistantNode)?.finalize();
  assistantNode = null;
}

function cancelAssistantStream() {
  if (assistantNode) streamSinks.get(assistantNode)?.cancel();
  assistantNode = null;
}

/** One builder for live, restored, and replayed thinking blocks. */
function createThinkingBlock(
  text,
  { open = true, live = false, elapsed = 0 } = {},
) {
  const wrap = document.createElement("div");
  wrap.className = "thinking";
  wrap.dataset.state = live ? "live" : "done";
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.append(icon("thought", "icon thinking-mark"));
  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = live
    ? "Thinking"
    : elapsed > 0
      ? `Thought for ${formatElapsed(elapsed)}`
      : "Thought";
  summary.append(label);
  const body = document.createElement("div");
  body.className = "thinking-body";
  body.textContent = text ?? "";
  details.append(summary, body);
  wrap.append(details);
  return { wrap, details, body, label };
}

function showThinking(text) {
  setHome(false);
  if (!thinkingNode) {
    const token = viewToken;
    const startedAt = Date.now();
    const { wrap, body, label } = createThinkingBlock("", {
      open: true,
      live: true,
    });
    transcriptEl.append(wrap);
    thinkingNode = body;
    streamSinks.set(
      body,
      createPacedText({
        onUpdate(visible) {
          if (token !== viewToken || !body.isConnected) return;
          body.textContent = visible;
          scrollToEnd();
        },
        onFinalize(raw) {
          if (token !== viewToken || !body.isConnected) return;
          body.textContent = raw;
          const elapsed = Date.now() - startedAt;
          label.textContent =
            elapsed >= 1000
              ? `Thought for ${formatElapsed(elapsed)}`
              : "Thought";
          wrap.dataset.state = "done";
          scrollToEnd();
        },
      }),
    );
  }
  streamSinks.get(thinkingNode)?.push(text);
}

function endThinkingBlock() {
  if (thinkingNode) {
    streamSinks.get(thinkingNode)?.finalize();
    thinkingNode = null;
  }
}

function toolStatusText(status) {
  if (status === "done") return "Done";
  if (status === "error") return "Failed";
  return "Running";
}

function toolStatusClass(status) {
  if (status === "done") return "done";
  if (status === "error") return "error";
  return "running";
}

function toolPath(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file_path", "file"]) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  return "";
}

function toolCard(toolCallId, name, args, status = "running") {
  setHome(false);
  const card = document.createElement("div");
  card.className = "tool tool-collapsed";
  card.dataset.toolCallId = toolCallId;
  card.dataset.outputText = "";
  card.dataset.outputExtra = "";
  card.dataset.toolPath = toolPath(args);

  const head = document.createElement("button");
  head.className = "tool-head";
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.append(icon(name === "bash" ? "terminal" : "tool"));

  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name;

  const summary = document.createElement("span");
  summary.className = "tool-summary";
  summary.textContent = summarizeArgs(args);

  const statusEl = document.createElement("span");
  statusEl.className = `tool-status ${toolStatusClass(status)}`;
  statusEl.textContent = toolStatusText(status);

  head.append(toolName, summary, statusEl);

  const body = document.createElement("div");
  body.className = "tool-body";
  const output = document.createElement("pre");
  output.className = "tool-output";
  body.append(output);

  head.addEventListener("click", () => {
    const collapsed = card.classList.toggle("tool-collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
  });
  card.append(head, body);
  renderTarget.append(card);
  toolCards.set(toolCallId, card);
  scrollToEnd();
  return card;
}

function findToolCard(toolCallId) {
  const tracked = toolCards.get(toolCallId);
  if (tracked?.isConnected) return tracked;
  return (
    renderTarget.querySelector(
      `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
    ) ?? null
  );
}

function renderToolOutput(card) {
  const output = card.querySelector(".tool-output");
  if (!output) return;
  let text = card.dataset.outputText ?? "";
  let prefix = "";
  const lines = text.split("\n");
  if (lines.length > MAX_TOOL_OUTPUT_LINES) {
    prefix += `… ${lines.length - MAX_TOOL_OUTPUT_LINES} earlier lines\n`;
    text = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
  }
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    prefix += "… earlier output truncated\n";
    text = text.slice(-MAX_TOOL_OUTPUT_CHARS);
  }
  output.textContent = prefix + text;
}

const toolOutputFrames = new WeakMap();

function appendToolOutput(card, text) {
  const combined = (card.dataset.outputText ?? "") + text;
  card.dataset.outputText =
    combined.length > MAX_TOOL_OUTPUT_CHARS
      ? combined.slice(-MAX_TOOL_OUTPUT_CHARS)
      : combined;
  if (!toolOutputFrames.has(card)) {
    const frame = requestAnimationFrame(() => {
      toolOutputFrames.delete(card);
      renderToolOutput(card);
    });
    toolOutputFrames.set(card, frame);
  }
  scrollToEnd();
}

function appendDiffSegments(code, segments, text) {
  if (!segments?.length) {
    code.textContent = text;
    return;
  }
  for (const part of segments) {
    if (part.changed) {
      const mark = document.createElement("mark");
      mark.className = "diff-word";
      mark.textContent = part.text;
      code.append(mark);
    } else {
      code.append(document.createTextNode(part.text));
    }
  }
}

/** Render a runtime `string[]` diff as an inline unified block. */
function appendToolDiff(card, lines) {
  card.dataset.outputExtra = Array.isArray(lines)
    ? lines.join("\n")
    : String(lines ?? "");
  const model = buildDiffModel(lines, { path: card.dataset.toolPath });
  let block = card.querySelector(".diff-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "diff-block";
    card.querySelector(".tool-body")?.append(block);
  }
  block.replaceChildren();

  const head = document.createElement("div");
  head.className = "diff-head";
  const label = document.createElement("span");
  label.className = "diff-label";
  label.textContent = "diff";
  const path = document.createElement("span");
  path.className = "diff-path";
  path.textContent = model.path || "changes";
  path.title = path.textContent;
  const stat = document.createElement("span");
  stat.className = "diff-stat";
  const added = document.createElement("span");
  added.className = "diff-stat-add";
  added.textContent = `+${model.added}`;
  const removed = document.createElement("span");
  removed.className = "diff-stat-del";
  removed.textContent = `−${model.removed}`;
  stat.append(added, removed);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.dataset.diffCopy = "";
  copy.textContent = "Copy";
  head.append(label, path, stat, copy);

  const body = document.createElement("div");
  body.className = "diff-body";
  for (const row of model.rows) {
    const line = document.createElement("div");
    line.className = `diff-line diff-${row.kind}`;
    if (row.kind === "add" || row.kind === "del") {
      line.setAttribute(
        "aria-label",
        `${row.kind === "add" ? "Added" : "Removed"}: ${row.text}`,
      );
    }
    const sign = document.createElement("span");
    sign.className = "diff-sign";
    sign.setAttribute("aria-hidden", "true");
    sign.textContent =
      row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
    const code = document.createElement("code");
    code.className = "diff-text";
    appendDiffSegments(code, row.segments, row.text);
    line.append(sign, code);
    body.append(line);
  }
  if (model.truncated) {
    const meta = document.createElement("div");
    meta.className = "diff-line diff-meta";
    meta.textContent = `… ${model.total - model.rows.length} more lines (Copy for the full diff)`;
    body.append(meta);
  }
  block.append(head, body);
}

function finishToolCard(card, result) {
  const outputFrame = toolOutputFrames.get(card);
  if (outputFrame !== undefined) {
    cancelAnimationFrame(outputFrame);
    toolOutputFrames.delete(card);
  }
  if (!card.dataset.outputText && typeof result.content === "string") {
    card.dataset.outputText = result.content;
  }
  renderToolOutput(card);
  if (Array.isArray(result.diff) && result.diff.length > 0) {
    appendToolDiff(card, result.diff);
  }
  const status = card.querySelector(".tool-status");
  if (status) {
    const state = result.isError ? "error" : "done";
    status.className = `tool-status ${toolStatusClass(state)}`;
    status.textContent = toolStatusText(state);
  }
  scrollToEnd();
}

function scrollToEnd(force = false) {
  if (renderTarget !== transcriptEl) return;
  if (force) stickToBottom = true;
  if (!stickToBottom) return;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    if (!stickToBottom) return;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });
}

/** Session events come in two shapes: a `message` object or a plain string. */
function messageOf(event) {
  if (typeof event.message === "string") return { content: event.message };
  return (
    event.message ?? { content: event.content, toolCalls: event.toolCalls }
  );
}

function appendHistoryEvents(events) {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "user_message") {
      const text = textFromMessage(messageOf(event));
      if (text) addUserMessage(text, true);
    } else if (event.type === "assistant_message") {
      const message = messageOf(event);
      const thinking =
        typeof message.thinking === "string" ? message.thinking.trim() : "";
      if (thinking) {
        renderTarget.append(createThinkingBlock(thinking).wrap);
      }
      const text = textFromMessage(message);
      if (text) {
        const body = assistantBlock();
        streamSinks.get(body)?.cancel();
        body.dataset.raw = text;
        body.innerHTML = renderMarkdown(text);
        body.classList.remove("streaming");
        body.closest(".msg-assistant")?.classList.remove("live");
        assistantNode = null;
      }
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const call of calls) {
        toolCard(call.id, call.name, call.arguments, "done");
      }
    } else if (event.type === "tool_result") {
      let card = findToolCard(event.toolCallId);
      if (!card) card = toolCard(event.toolCallId, event.name, {}, "done");
      finishToolCard(card, event);
    }
  }
}

function loadEarlierHistory() {
  if (historyLimit >= historyEvents.length) return;
  const oldHeight = transcriptEl.scrollHeight;
  const oldTop = transcriptEl.scrollTop;
  const oldLimit = historyLimit;
  historyLimit = Math.min(
    historyLimit + HISTORY_PAGE_EVENTS,
    historyEvents.length,
  );
  const older = historyEvents.slice(
    historyEvents.length - historyLimit,
    historyEvents.length - oldLimit,
  );
  const container = document.createElement("div");
  renderTarget = container;
  try {
    appendHistoryEvents(older);
  } finally {
    renderTarget = transcriptEl;
  }
  transcriptEl.querySelector(".load-earlier-row")?.remove();
  const fragment = document.createDocumentFragment();
  while (container.firstChild) fragment.append(container.firstChild);
  transcriptEl.insertBefore(fragment, transcriptEl.firstChild);
  const boundary = loadEarlierBoundary();
  if (boundary) transcriptEl.insertBefore(boundary, transcriptEl.firstChild);
  stickToBottom = false;
  renderMermaidBlocks();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      transcriptEl.scrollTop = oldTop + (transcriptEl.scrollHeight - oldHeight);
    });
  });
}

function loadEarlierBoundary() {
  const remaining = historyEvents.length - historyLimit;
  if (remaining <= 0) return null;
  const row = document.createElement("div");
  row.className = "load-earlier-row";
  const button = document.createElement("button");
  button.className = "load-earlier";
  button.type = "button";
  const count = Math.min(HISTORY_PAGE_EVENTS, remaining);
  button.textContent = `Load ${count} earlier message${count === 1 ? "" : "s"}`;
  button.addEventListener("click", loadEarlierHistory);
  row.append(button);
  return row;
}

function renderHistoryPage() {
  beginTranscriptView();
  const boundary = loadEarlierBoundary();
  if (boundary) transcriptEl.append(boundary);
  appendHistoryEvents(historyEvents.slice(-historyLimit));
  endAssistantBlock();
  endThinkingBlock();
  setHome(!transcriptEl.querySelector(".msg, .tool, .thinking"));
  renderMermaidBlocks();
  scrollToEnd(true);
}

function renderHistory(events) {
  historyEvents = Array.isArray(events) ? events : [];
  historyLimit = Math.min(HISTORY_PAGE_EVENTS, historyEvents.length);
  renderHistoryPage();
}

/** Rebuild the active turn after a reconnect; hello already rendered history. */
function renderReplay(message) {
  const events = message.events ?? [];
  // The replay is the only signal that a turn is still running after a
  // reconnect, so mark the turn active before rebuilding its events.
  setTurnActive(true);
  if (message.truncated) {
    showToast(
      "Reconnect replay was truncated; some live output may be missing.",
      "warn",
    );
  }
  for (const prompt of message.prompts ?? []) addUserMessage(prompt, true);
  for (const event of events) handleEvent(event);
  scrollToEnd(true);
}

/* ---------------- sessions ---------------- */

function formatUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  date.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "Previous 7 days";
  if (diff <= 30) return "Previous 30 days";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function sessionRows() {
  const rows = [...sessionsCache];
  if (
    currentSessionId &&
    !rows.some((session) => session.id === currentSessionId)
  ) {
    rows.push({
      id: currentSessionId,
      title: "New chat",
      messageCount: 0,
      updatedAt: new Date().toISOString(),
    });
  }
  const query = sessionSearchEl?.value.trim().toLowerCase() ?? "";
  const filtered = query
    ? rows.filter((session) =>
        (session.title || "Untitled session").toLowerCase().includes(query),
      )
    : rows;
  return filtered.sort((a, b) => {
    const at = new Date(a.updatedAt ?? 0).getTime() || 0;
    const bt = new Date(b.updatedAt ?? 0).getTime() || 0;
    return bt - at;
  });
}

function renderSessions(sessions) {
  sessionsCache = Array.isArray(sessions) ? sessions : [];
  sessionsEl.replaceChildren();

  const groups = new Map();
  for (const session of sessionRows()) {
    const label = groupLabel(session.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(session);
  }

  if (groups.size === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No chats found";
    sessionsEl.append(empty);
  }

  for (const [label, rows] of groups) {
    const group = document.createElement("div");
    group.className = "session-group";
    const title = document.createElement("div");
    title.className = "session-group-title";
    title.textContent = label;
    group.append(title);

    for (const session of rows) {
      const wrapper = document.createElement("div");
      wrapper.className = "session-row";

      const row = document.createElement("button");
      row.type = "button";
      row.className = "session-item";
      row.dataset.sessionId = session.id;
      row.disabled = readOnly;
      row.title = `${session.messageCount ?? 0} messages${
        formatUpdatedAt(session.updatedAt)
          ? ` · ${formatUpdatedAt(session.updatedAt)}`
          : ""
      }`;
      if (session.id === currentSessionId) {
        row.classList.add("active");
        row.setAttribute("aria-current", "page");
      }
      const text = document.createElement("span");
      text.className = "session-title";
      text.textContent = session.title || "Untitled session";
      row.append(text);
      row.addEventListener("click", () => {
        if (readOnly || session.id === currentSessionId) return;
        send({ type: "resume_session", id: session.id });
        closeMobileSidebar();
      });

      const menuButton = document.createElement("button");
      menuButton.type = "button";
      menuButton.className = "session-menu-btn";
      menuButton.setAttribute("aria-label", `Options for ${text.textContent}`);
      menuButton.setAttribute("aria-haspopup", "menu");
      menuButton.disabled = readOnly;
      menuButton.append(icon("more"));
      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (readOnly) return;
        const isOpen =
          !sessionMenu.hidden && sessionMenuTarget?.id === session.id;
        closePopovers();
        if (isOpen) return;
        sessionMenuTarget = {
          id: session.id,
          title: text.textContent,
          button: menuButton,
        };
        wrapper.classList.add("menu-open");
        sessionMenu.hidden = false;
        placePopover(sessionMenu, menuButton, true);
        sessionMenu.querySelector("button")?.focus();
      });

      wrapper.append(row, menuButton);
      group.append(wrapper);
    }
    sessionsEl.append(group);
  }

  updateSessionControls();
}

function updateSessionControls() {
  newSessionEl.disabled = readOnly;
  modelButton.disabled = readOnly;
  effortButton.disabled = readOnly;
  modeButton.disabled = readOnly;
  attachButton.disabled = readOnly;
  for (const suggestion of suggestionsEl.querySelectorAll(".suggestion")) {
    suggestion.disabled = readOnly;
  }
  for (const row of sessionsEl.querySelectorAll(".session-item")) {
    row.disabled = readOnly;
  }
  for (const button of sessionsEl.querySelectorAll(".session-menu-btn")) {
    button.disabled = readOnly;
  }
}

function scheduleSessionRender() {
  if (sessionRenderTimer) return;
  sessionRenderTimer = setTimeout(() => {
    sessionRenderTimer = null;
    renderSessions(sessionsCache);
  }, 60);
}

function applySession(message) {
  if (listening) stopVoiceInput();
  currentSessionId = message.sessionId;
  clearAttachments();
  renderHistory(message.history ?? []);
  renderSessions(sessionsCache);
}

/* ---------------- sidebar ---------------- */

function isMobile() {
  return mobileQuery.matches;
}

function closeMobileSidebar() {
  if (!document.body.classList.contains("sidebar-open")) return;
  document.body.classList.remove("sidebar-open");
  syncSidebar();
  inputEl.focus();
}

function syncSidebar() {
  const mobile = isMobile();
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  const open = document.body.classList.contains("sidebar-open");
  const expanded = mobile ? open : !collapsed;
  sidebarScrim.hidden = !(mobile && open);
  sidebarToggle.setAttribute("aria-expanded", String(expanded));
  sidebarToggle.setAttribute(
    "aria-label",
    expanded ? "Close sidebar" : "Open sidebar",
  );
  sidebarClose.setAttribute(
    "aria-label",
    mobile ? "Close sidebar" : "Collapse sidebar",
  );
}

function toggleSidebar() {
  if (isMobile()) {
    document.body.classList.toggle("sidebar-open");
  } else {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open");
    } catch {
      // storage can be unavailable; the state still applies for this page.
    }
  }
  syncSidebar();
}

function collapseSidebar() {
  if (isMobile()) {
    closeMobileSidebar();
    return;
  }
  document.body.classList.add("sidebar-collapsed");
  try {
    localStorage.setItem(SIDEBAR_KEY, "collapsed");
  } catch {
    // best effort
  }
  syncSidebar();
}

try {
  if (localStorage.getItem(SIDEBAR_KEY) === "collapsed") {
    document.body.classList.add("sidebar-collapsed");
  }
} catch {
  // default to the expanded sidebar
}

sidebarToggle.addEventListener("click", toggleSidebar);
sidebarClose.addEventListener("click", collapseSidebar);
sidebarScrim.addEventListener("click", closeMobileSidebar);
mobileQuery.addEventListener("change", () => {
  document.body.classList.remove("sidebar-open");
  syncSidebar();
});
syncSidebar();

/* ---------------- toast ---------------- */

function showToast(message, tone = "info", persistent = false) {
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (!persistent) {
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, 5000);
  }
}

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastEl.hidden = true;
}

/* ---------------- model, workspace, theme controls ---------------- */

function renderModelLabel() {
  const label = currentModel
    ? `${currentProvider} · ${currentModel}`
    : currentProvider || "Atom-lite";
  modelNameEl.textContent = label;
  modelButton.title = `Switch model · ${label}`;
}

function renderWorkspaceLabel() {
  workspacePathText.textContent = workspacePath || "Select a folder…";
  workspacePathEl.title = workspacePath
    ? `Working directory: ${workspacePath} (Ctrl+O to change)`
    : "Choose a working directory (Ctrl+O)";
}

function filteredModels() {
  const query = modelSearch.value.trim().toLowerCase();
  if (!query) return modelsCache;
  return modelsCache.filter(
    (item) =>
      item.provider.toLowerCase().includes(query) ||
      item.model.toLowerCase().includes(query) ||
      (item.label ?? "").toLowerCase().includes(query),
  );
}

function renderModelList() {
  modelList.replaceChildren();
  const filtered = filteredModels();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "overlay-empty";
    empty.textContent = "No models match this search.";
    modelList.append(empty);
    return;
  }
  let group = "";
  for (const option of filtered) {
    if (option.provider !== group) {
      group = option.provider;
      const title = document.createElement("div");
      title.className = "popover-group-title";
      title.textContent = option.label || group;
      modelList.append(title);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overlay-item";
    button.setAttribute(
      "aria-selected",
      String(
        option.provider === currentProvider && option.model === currentModel,
      ),
    );
    const main = document.createElement("div");
    main.className = "overlay-item-main";
    const title = document.createElement("div");
    title.className = "overlay-item-title";
    title.textContent = option.model;
    const sub = document.createElement("div");
    sub.className = "overlay-item-sub";
    sub.textContent = option.provider;
    main.append(title, sub);
    button.append(main, icon("check", "icon popover-check"));
    button.addEventListener("click", () => {
      closeModal(modelModal);
      switchToModel(option);
    });
    modelList.append(button);
  }
  modelIndex = 0;
  modelList.querySelector(".overlay-item")?.classList.add("selected");
}

function refreshModelsLive() {
  modelRefresh.disabled = true;
  modelRefresh.textContent = "Refreshing…";
  send({ type: "refresh_models" });
}

function openModelModal() {
  if (readOnly) {
    showToast("This tab is a read-only viewer.", "warn");
    return;
  }
  closePopovers();
  modelSearch.value = "";
  renderModelList();
  openModal(modelModal);
  modelButton.setAttribute("aria-expanded", "true");
  modelSearch.focus();
  refreshModelsLive();
}

function moveModelSelection(delta) {
  const items = [...modelList.querySelectorAll(".overlay-item")];
  if (items.length === 0) return;
  items[modelIndex]?.classList.remove("selected");
  modelIndex = (modelIndex + delta + items.length) % items.length;
  items[modelIndex]?.classList.add("selected");
  items[modelIndex]?.scrollIntoView({ block: "nearest" });
}

function switchToModel(option) {
  if (readOnly) return;
  modelButton.disabled = true;
  showToast(`Switching to ${option.provider} · ${option.model}…`);
  send({
    type: "switch_model",
    provider: option.provider,
    model: option.model,
  });
}

function openThemeMenu() {
  closePopovers(themeMenu);
  themeMenu.hidden = false;
  placePopover(themeMenu, themeToggle, true);
  themeToggle.setAttribute("aria-expanded", "true");
  themeMenu.querySelector(`[data-theme-mode="${themeMode}"]`)?.focus();
}

/* ---------------- effort and mode ---------------- */

const EFFORTS = ["low", "medium", "high"];
const MODES = ["plan", "yolo"];

function effortText(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Medium";
}

function renderRuntimeState() {
  effortLabel.textContent = effortText(currentEffort);
  modeLabel.textContent = currentMode.toUpperCase();
  modeButton.classList.toggle("mode-plan", currentMode === "plan");
  effortButton.setAttribute("aria-label", `Effort: ${currentEffort} — change`);
  modeButton.setAttribute("aria-label", `Mode: ${currentMode} — change`);
  for (const item of effortMenu.querySelectorAll("[data-value]")) {
    item.setAttribute(
      "aria-checked",
      String(item.dataset.value === currentEffort),
    );
  }
  for (const item of modeMenu.querySelectorAll("[data-value]")) {
    item.setAttribute(
      "aria-checked",
      String(item.dataset.value === currentMode),
    );
  }
}

function buildChoiceMenu(menu, values, label, onSelect) {
  menu.replaceChildren();
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "popover-item";
    button.dataset.value = value;
    button.setAttribute("role", "menuitemradio");
    const text = document.createElement("span");
    text.className = "popover-item-label";
    text.textContent = label(value);
    button.append(text, icon("check", "icon popover-check"));
    button.addEventListener("click", () => {
      closePopovers();
      onSelect(value);
    });
    menu.append(button);
  }
  renderRuntimeState();
}

function openEffortMenu() {
  if (readOnly) return;
  closePopovers(effortMenu);
  effortMenu.hidden = false;
  placePopover(effortMenu, effortButton, true);
  effortButton.setAttribute("aria-expanded", "true");
  renderRuntimeState();
  effortMenu.querySelector(`[data-value="${currentEffort}"]`)?.focus();
}

function openModeMenu() {
  if (readOnly) return;
  closePopovers(modeMenu);
  modeMenu.hidden = false;
  placePopover(modeMenu, modeButton, true);
  modeButton.setAttribute("aria-expanded", "true");
  renderRuntimeState();
  modeMenu.querySelector(`[data-value="${currentMode}"]`)?.focus();
}

function setEffort(value) {
  if (readOnly || !EFFORTS.includes(value)) return;
  send({ type: "set_effort", effort: value });
}

function setMode(value) {
  if (readOnly || !MODES.includes(value)) return;
  send({ type: "set_mode", mode: value });
}

buildChoiceMenu(effortMenu, EFFORTS, effortText, setEffort);
buildChoiceMenu(modeMenu, MODES, (value) => value.toUpperCase(), setMode);

/* ---------------- session row actions and dialogs ---------------- */

function currentTitle() {
  return (
    sessionsCache.find((session) => session.id === currentSessionId)?.title ||
    "Untitled session"
  );
}

function hideLayer(layer) {
  layer.hidden = true;
  if (layer === modelModal) {
    modelButton.setAttribute("aria-expanded", "false");
  }
  if (layer === skillsModal || layer === mcpModal) {
    delete layer.dataset.pending;
  }
}

function openModal(layer) {
  if (!layer.hidden) return;
  const otherLayers = [...document.querySelectorAll(".modal-layer")].filter(
    (open) => open !== layer && !open.hidden,
  );
  if (otherLayers.length === 0) modalReturnFocus = document.activeElement;
  for (const open of otherLayers) hideLayer(open);
  layer.hidden = false;
  layer.querySelector(".modal")?.focus();
}

function closeModal(layer) {
  if (layer.hidden) return;
  hideLayer(layer);
  const stillOpen = [...document.querySelectorAll(".modal-layer")].some(
    (open) => !open.hidden,
  );
  if (stillOpen) return;
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target && typeof target.focus === "function") target.focus();
}

function openRenameModal(id, title) {
  renameTargetId = id;
  renameInput.value = title;
  openModal(renameModal);
  renameInput.focus();
  renameInput.select();
}

function openDeleteModal(id, title) {
  deleteTargetId = id;
  deleteDesc.textContent = `“${title}” will be permanently removed.`;
  openModal(deleteModal);
  deleteConfirm.focus();
}

/* ---------------- workspace explorer ---------------- */

function browseDirectory(path) {
  send({ type: "browse_directory", path });
}

function renderDirectory(listing) {
  directoryListing = listing;
  workspacePathInput.value = listing.path;
  workspaceUp.disabled = !listing.parent;
  dirList.replaceChildren();

  for (const entry of listing.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "popover-item";
    const label = document.createElement("span");
    label.className = "popover-item-label";
    label.textContent = entry.name;
    button.append(icon("folder"), label);
    button.addEventListener("click", () => browseDirectory(entry.path));
    dirList.append(button);
  }

  if (listing.directories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dir-empty";
    empty.textContent = "No subfolders here.";
    dirList.append(empty);
  }
}

function openWorkspaceModal(path) {
  if (readOnly) {
    showToast("This tab is a read-only viewer.", "warn");
    return;
  }
  openModal(workspaceModal);
  dirList.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "dir-empty";
  loading.textContent = "Loading folders…";
  dirList.append(loading);
  browseDirectory(path || workspacePath || undefined);
  workspacePathInput.focus();
}

function useWorkspace() {
  const path = directoryListing?.path ?? workspacePathInput.value.trim();
  if (!path) return;
  closeModal(workspaceModal);
  showToast(`Switching to ${path}…`);
  send({ type: "switch_workspace", path });
}

/* ---------------- attachments ---------------- */

const ATTACHMENT_MARKER = "\n\n[Attached local files]";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function displayText(text) {
  const index = text.indexOf(ATTACHMENT_MARKER);
  return index >= 0 ? text.slice(0, index) : text;
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachments() {
  attachmentsEl.replaceChildren();
  if (attachments.length === 0) {
    attachmentsEl.hidden = true;
    return;
  }
  attachmentsEl.hidden = false;
  for (const item of attachments) {
    const chip = document.createElement("div");
    chip.className = `attachment${item.pending ? " pending" : ""}${
      item.error ? " failed" : ""
    }`;
    chip.append(icon("file"));
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.name;
    name.title = item.name;
    const size = document.createElement("span");
    size.className = "attachment-size";
    size.textContent = item.error ? "too large" : fileSize(item.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.append(icon("x"));
    remove.addEventListener("click", () => removeAttachment(item));
    chip.append(name, size, remove);
    attachmentsEl.append(chip);
  }
}

function removeAttachment(item) {
  if (item.path) send({ type: "remove_attachment", path: item.path });
  else if (item.pending && item.id) cancelledUploads.add(item.id);
  attachments = attachments.filter((entry) => entry !== item);
  renderAttachments();
  syncSendState();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

async function attachFiles(files) {
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      showToast(`At most ${MAX_ATTACHMENTS} attachments per message.`, "warn");
      break;
    }
    const entry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      pending: true,
      error: file.size > MAX_ATTACHMENT_BYTES,
    };
    attachments.push(entry);
    renderAttachments();
    syncSendState();
    if (entry.error) {
      entry.pending = false;
      renderAttachments();
      syncSendState();
      continue;
    }
    try {
      const data = await fileToBase64(file);
      send({
        type: "attach_file",
        id: entry.id,
        name: entry.name,
        mime: entry.mime,
        data,
      });
    } catch {
      entry.pending = false;
      entry.error = true;
      renderAttachments();
      syncSendState();
    }
  }
}

function applyAttachment(message) {
  if (message.id && cancelledUploads.has(message.id)) {
    // The session may have already cleaned this directory; the late response
    // is only a tombstone, never a reason to reopen or error.
    cancelledUploads.delete(message.id);
    return;
  }
  const entry =
    (message.id
      ? attachments.find((item) => item.id === message.id)
      : undefined) ??
    attachments.find((item) => item.pending && item.name === message.name) ??
    attachments.find((item) => item.pending);
  if (!entry) return;
  entry.pending = false;
  entry.error = false;
  entry.path = message.path;
  entry.size = message.size;
  entry.mime = message.mime;
  renderAttachments();
  syncSendState();
}

function clearAttachments() {
  for (const item of attachments) {
    if (item.pending && item.id) cancelledUploads.add(item.id);
  }
  attachments = [];
  renderAttachments();
  syncSendState();
}

/* ---------------- skills and MCP overlays ---------------- */

function overlayEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "overlay-empty";
  empty.textContent = text;
  return empty;
}

function renderSkills(skills) {
  skillsList.replaceChildren();
  if (!Array.isArray(skills) || skills.length === 0) {
    skillsList.append(overlayEmpty("No skills discovered in this workspace."));
  } else {
    for (const skill of skills) {
      const item = document.createElement("button");
      item.className = "overlay-item";
      item.type = "button";
      const main = document.createElement("div");
      main.className = "overlay-item-main";
      const title = document.createElement("div");
      title.className = "overlay-item-title";
      title.textContent = skill.name;
      const description = document.createElement("div");
      description.className = "overlay-item-sub";
      description.textContent = skill.description || "No description";
      main.append(title, description);
      const meta = document.createElement("span");
      meta.className = "overlay-item-meta";
      meta.textContent = skill.scope ?? "";
      item.append(main, meta);
      item.addEventListener("click", () => {
        const insert = `/${skill.name} `;
        const start = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? start;
        inputEl.setRangeText(insert, start, end, "end");
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        closeModal(skillsModal);
        inputEl.focus();
      });
      skillsList.append(item);
    }
  }
  const pending = skillsModal.dataset.pending === "1";
  delete skillsModal.dataset.pending;
  if (pending) openModal(skillsModal);
}

function openSkillsModal() {
  closePopovers();
  skillsModal.dataset.pending = "1";
  skillsList.replaceChildren(overlayEmpty("Loading skills…"));
  openModal(skillsModal);
  send({ type: "list_skills" });
}

function renderMcp(servers) {
  mcpList.replaceChildren();
  if (!Array.isArray(servers) || servers.length === 0) {
    mcpList.append(overlayEmpty("No MCP servers configured."));
  } else {
    for (const server of servers) {
      const item = document.createElement("div");
      item.className = "overlay-item";
      const state = document.createElement("span");
      state.className = `mcp-state ${server.state}`;
      const main = document.createElement("div");
      main.className = "overlay-item-main";
      const title = document.createElement("div");
      title.className = "overlay-item-title";
      title.textContent = server.name;
      const description = document.createElement("div");
      description.className = "overlay-item-sub";
      const tools = Array.isArray(server.tools) ? server.tools : [];
      description.textContent = server.lastError
        ? server.lastError
        : tools.length
          ? tools.join(", ")
          : "No tools exposed";
      main.append(title, description);
      const meta = document.createElement("span");
      meta.className = "overlay-item-meta";
      meta.textContent = `${server.enabled ? server.state : "disabled"} · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
      item.append(state, main, meta);
      mcpList.append(item);
    }
  }
  const pending = mcpModal.dataset.pending === "1";
  delete mcpModal.dataset.pending;
  if (pending) openModal(mcpModal);
}

function openMcpModal() {
  closePopovers();
  mcpModal.dataset.pending = "1";
  mcpList.replaceChildren(overlayEmpty("Loading MCP servers…"));
  openModal(mcpModal);
  send({ type: "list_mcp" });
}

/* ---------------- slash commands and palette ---------------- */

const COMMANDS = [
  {
    name: "new",
    aliases: ["clear", "n"],
    description: "Start a new chat",
    run() {
      sessionSearchEl.value = "";
      send({ type: "new_session" });
      closeMobileSidebar();
    },
  },
  {
    name: "help",
    aliases: ["?"],
    description: "Show available commands",
    run() {
      openPalette();
    },
  },
  {
    name: "stop",
    aliases: ["cancel"],
    description: "Stop the running turn",
    run() {
      if (!stopAgent()) showToast("Nothing is running.", "warn");
    },
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Switch provider or model",
    run(args) {
      if (!args) {
        openModelModal();
        return;
      }
      const target =
        modelsCache.find(
          (item) =>
            `${item.provider}/${item.model}` === args || item.model === args,
        ) ?? modelsCache.find((item) => item.provider === args);
      if (target) switchToModel(target);
      else showToast(`No model matches “${args}”`, "error");
    },
  },
  {
    name: "theme",
    description: "Set theme: system, light, dark",
    run(args) {
      if (args === "system" || args === "light" || args === "dark") {
        applyTheme(args);
      } else {
        openThemeMenu();
      }
    },
  },
  {
    name: "cwd",
    aliases: ["workspace", "w"],
    description: "Change working directory",
    run(args) {
      if (args) {
        showToast(`Switching to ${args}…`);
        send({ type: "switch_workspace", path: args });
      } else {
        openWorkspaceModal();
      }
    },
  },
  {
    name: "rename",
    aliases: ["r"],
    description: "Rename this chat",
    run(args) {
      if (args)
        send({ type: "rename_session", id: currentSessionId, title: args });
      else openRenameModal(currentSessionId, currentTitle());
    },
  },
  {
    name: "delete",
    aliases: ["d"],
    description: "Delete this chat",
    run() {
      openDeleteModal(currentSessionId, currentTitle());
    },
  },
  {
    name: "search",
    aliases: ["find"],
    description: "Filter chat history",
    run(args) {
      sessionSearchEl.value = args;
      scheduleSessionRender();
      sessionSearchEl.focus();
    },
  },
  {
    name: "export",
    description: "Download this transcript",
    run() {
      exportTranscript();
    },
  },
  {
    name: "effort",
    description: "Set effort: low, medium, high",
    run(args) {
      if (args) setEffort(args.toLowerCase());
      else openEffortMenu();
    },
  },
  {
    name: "mode",
    description: "Set mode: plan or yolo",
    run(args) {
      if (args) setMode(args.toLowerCase());
      else openModeMenu();
    },
  },
  {
    name: "skills",
    description: "Show available skills",
    run() {
      openSkillsModal();
    },
  },
  {
    name: "mcp",
    description: "Show connected MCP servers",
    run() {
      openMcpModal();
    },
  },
];

const READ_ONLY_COMMANDS = [
  "help",
  "theme",
  "search",
  "export",
  "skills",
  "mcp",
];

function availableCommands() {
  return readOnly
    ? COMMANDS.filter((command) => READ_ONLY_COMMANDS.includes(command.name))
    : COMMANDS;
}

function findCommand(name) {
  return COMMANDS.find(
    (command) =>
      command.name === name || (command.aliases ?? []).includes(name),
  );
}

function parseSlash(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function runCommand(command, args = "") {
  if (readOnly && !READ_ONLY_COMMANDS.includes(command.name)) {
    showToast("This tab is a read-only viewer.", "warn");
    return;
  }
  command.run(args);
}

function exportTranscript() {
  const lines = ["# Atom-lite conversation", ""];
  for (const node of transcriptEl.children) {
    if (node.classList.contains("msg-user")) {
      lines.push(
        "## You",
        "",
        node.querySelector(".msg-body")?.textContent ?? "",
        "",
      );
    } else if (node.classList.contains("msg-assistant")) {
      lines.push(
        "## Atom-lite",
        "",
        node.querySelector(".msg-markdown")?.dataset.raw ??
          node.textContent ??
          "",
        "",
      );
    } else if (node.classList.contains("tool")) {
      lines.push(
        `> Tool: ${node.querySelector(".tool-name")?.textContent ?? "tool"}`,
        "",
        "```text",
        node.querySelector(".tool-output")?.textContent ?? "",
        "```",
        "",
      );
    }
  }
  const url = URL.createObjectURL(
    new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "atom-lite-chat.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Transcript exported.");
}

function updateSlashMenu() {
  const value = inputEl.value;
  const firstLine = value.split("\n")[0];
  if (
    !firstLine.startsWith("/") ||
    value.includes("\n") ||
    value.trim().split(/\s+/).length > 1
  ) {
    slashMenu.hidden = true;
    return;
  }
  const query = firstLine.slice(1).toLowerCase();
  slashItems = availableCommands()
    .filter(
      (command) =>
        command.name.startsWith(query) ||
        (command.aliases ?? []).some((alias) => alias.startsWith(query)),
    )
    .slice(0, 13);
  if (slashItems.length === 0) {
    slashMenu.hidden = true;
    return;
  }
  slashIndex = Math.min(slashIndex, slashItems.length - 1);
  slashMenu.replaceChildren();
  for (const [index, command] of slashItems.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `popover-item${index === slashIndex ? " selected" : ""}`;
    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = `/${command.name}`;
    const description = document.createElement("span");
    description.className = "palette-desc";
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("click", () => {
      const chosen = command;
      inputEl.value = "";
      syncSendState();
      slashMenu.hidden = true;
      runCommand(chosen);
    });
    slashMenu.append(button);
  }
  slashMenu.hidden = false;
  placePopover(slashMenu, composerEl, true);
}

function renderPalette() {
  const query = paletteInput.value.trim().toLowerCase();
  paletteItems = availableCommands().filter(
    (command) =>
      command.name.includes(query) ||
      command.description.toLowerCase().includes(query) ||
      (command.aliases ?? []).some((alias) => alias.includes(query)),
  );
  paletteIndex = 0;
  paletteList.replaceChildren();
  for (const [index, command] of paletteItems.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `palette-item${index === paletteIndex ? " selected" : ""}`;
    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = `/${command.name}`;
    const description = document.createElement("span");
    description.className = "palette-desc";
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("click", () => {
      const chosen = command;
      closeModal(paletteModal);
      runCommand(chosen);
    });
    paletteList.append(button);
  }
  if (paletteItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "popover-empty";
    empty.textContent = "No commands match.";
    paletteList.append(empty);
  }
}

function openPalette() {
  if (!paletteModal.hidden) return;
  modalReturnFocus = document.activeElement;
  paletteInput.value = "";
  renderPalette();
  paletteModal.hidden = false;
  paletteInput.focus();
}

/* ---------------- protocol ---------------- */

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "assistant_delta":
    case "assistant_text":
      appendAssistantText(event.text);
      scrollToEnd();
      break;
    case "thinking_delta":
      showThinking(event.text);
      break;
    case "tool_call": {
      // Assistant prose before a tool call is a finished block; later text
      // must appear after the card, not above it.
      endAssistantBlock();
      endThinkingBlock();
      toolCard(event.id, event.name, event.args, "running");
      break;
    }
    case "tool_output": {
      const card = findToolCard(event.toolCallId);
      if (card) appendToolOutput(card, event.text);
      break;
    }
    case "tool_result": {
      const card = findToolCard(event.toolCallId);
      if (card) finishToolCard(card, event);
      break;
    }
    default:
      break;
  }
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return `$ ${args.command}`;
  for (const key of ["path", "file_path", "file", "url", "pattern", "query"]) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  try {
    const json = JSON.stringify(args);
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}

function setReadOnly(next) {
  readOnly = Boolean(next);
  roleEl.hidden = false;
  roleEl.classList.toggle("role-control", !readOnly);
  roleEl.textContent = readOnly ? "Read-only viewer" : "Controlling";
  inputEl.disabled = readOnly;
  if (readOnly) {
    approvalLayer.hidden = true;
  } else if (lastApproval && !pendingApproval) {
    openApproval(lastApproval);
  }
  syncSendState();
  updateSessionControls();
}

function handleMessage(message) {
  switch (message.type) {
    case "hello":
      setReadOnly(message.readOnly);
      currentProvider = message.provider;
      currentModel = message.model;
      modelsCache = Array.isArray(message.models) ? message.models : [];
      workspacePath = message.workspace ?? workspacePath;
      currentMode = message.mode ?? "yolo";
      currentEffort = message.effort ?? "medium";
      renderRuntimeState();
      const label = `${message.provider} · ${message.model}`;
      metaEl.textContent = label;
      renderModelLabel();
      renderWorkspaceLabel();
      if (!modelModal.hidden) renderModelList();
      hideToast();
      setTurnActive(false);
      applySession(message);
      send({ type: "list_sessions" });
      break;
    case "control":
      setReadOnly(message.readOnly);
      break;
    case "event":
      handleEvent(message.event);
      break;
    case "replay":
      renderReplay(message);
      break;
    case "user_input":
      addUserMessage(message.text, true);
      break;
    case "turn_start":
      endAssistantBlock();
      endThinkingBlock();
      setTurnActive(true);
      break;
    case "turn_stopping":
      pendingApproval = null;
      lastApproval = null;
      approvalLayer.hidden = true;
      break;
    case "turn_end":
      endAssistantBlock();
      endThinkingBlock();
      clearQueued();
      renderMermaidBlocks();
      setTurnActive(false);
      send({ type: "list_sessions" });
      break;
    case "input_queued":
      queuedMessages.push(message.text);
      renderQueued();
      break;
    case "approval_request":
      lastApproval = message;
      if (!readOnly) openApproval(message);
      break;
    case "sessions":
      closePopovers();
      renderSessions(message.sessions);
      if (
        pendingRename &&
        message.sessions.some(
          (session) =>
            session.id === pendingRename.id &&
            session.title === pendingRename.title,
        )
      ) {
        pendingRename = null;
        showToast("Chat renamed.");
      }
      if (
        pendingDelete &&
        !message.sessions.some((session) => session.id === pendingDelete)
      ) {
        pendingDelete = null;
        showToast("Chat deleted.");
      }
      break;
    case "session_changed":
      closePopovers();
      setTurnActive(false);
      applySession(message);
      break;
    case "workspace_changed":
      workspacePath = message.workspace;
      renderWorkspaceLabel();
      setTurnActive(false);
      applySession(message);
      closeModal(workspaceModal);
      showToast(`Workspace: ${workspacePath}`);
      break;
    case "model_changed":
      currentProvider = message.provider;
      currentModel = message.model;
      modelsCache = Array.isArray(message.models) ? message.models : [];
      metaEl.textContent = `${currentProvider} · ${currentModel}`;
      renderModelLabel();
      if (!modelModal.hidden) renderModelList();
      modelButton.disabled = readOnly;
      showToast(`Using ${currentProvider} · ${currentModel}`);
      break;
    case "directory":
      renderDirectory(message.listing);
      break;
    case "runtime_state":
      currentMode = message.mode;
      currentEffort = message.effort;
      renderRuntimeState();
      break;
    case "models":
      modelsCache = Array.isArray(message.models) ? message.models : [];
      modelRefresh.disabled = false;
      modelRefresh.textContent = "Refresh";
      if (!modelModal.hidden) renderModelList();
      break;
    case "attachment":
      applyAttachment(message);
      break;
    case "attachment_removed":
      attachments = attachments.filter((item) => item.path !== message.path);
      renderAttachments();
      break;
    case "skills":
      renderSkills(message.skills);
      break;
    case "mcp":
      renderMcp(message.servers);
      break;
    case "error":
      modelButton.disabled = readOnly;
      pendingRename = null;
      pendingDelete = null;
      if (!modelModal.hidden) {
        modelRefresh.disabled = false;
        modelRefresh.textContent = "Refresh";
      }
      showToast(message.message, "error");
      break;
    default:
      break;
  }
}

function openApproval(message) {
  if (readOnly) return;
  if (approvalLayer.hidden) {
    approvalReturnFocus = document.activeElement;
  }
  pendingApproval = { id: message.id, turnId: message.turnId };
  approvalTool.textContent = message.request.tool
    ? `tool · ${message.request.tool}`
    : "";
  approvalCommand.textContent = message.request.command ?? "";
  approvalCwd.textContent = message.request.cwd ?? "";
  approvalLayer.hidden = false;
  approvalLayer.querySelector(".approval")?.focus();
}

function closeApproval(decision) {
  if (pendingApproval) {
    send({
      type: "approval",
      id: pendingApproval.id,
      turnId: pendingApproval.turnId,
      decision,
    });
  }
  pendingApproval = null;
  lastApproval = null;
  approvalLayer.hidden = true;
  const target = approvalReturnFocus ?? inputEl;
  approvalReturnFocus = null;
  if (target && typeof target.focus === "function") target.focus();
}

approvalLayer.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeApproval("deny");
    return;
  }
  if (event.key !== "Tab") return;
  // A modal keeps keyboard focus inside it.
  const buttons = [...approvalLayer.querySelectorAll("[data-decision]")];
  if (buttons.length === 0) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  const active = document.activeElement;
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (
    event.shiftKey &&
    (active === first || active?.classList.contains("approval"))
  ) {
    event.preventDefault();
    last.focus();
  }
});

for (const button of approvalLayer.querySelectorAll("[data-decision]")) {
  button.addEventListener("click", () =>
    closeApproval(button.dataset.decision),
  );
}

/* ---------------- transcript actions ---------------- */

transcriptEl.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (target.classList.contains("image-error")) return;
    target.classList.add("image-error");
    const fallback = document.createElement("div");
    fallback.className = "image-fallback";
    fallback.append(
      icon("image"),
      document.createTextNode(`Image unavailable: ${target.alt || "image"}`),
    );
    target.after(fallback);
  },
  true,
);

transcriptEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const image = target.closest("img.md-image");
  if (!image || image.classList.contains("image-error")) return;
  imagePreview.src = image.src;
  imagePreview.alt = image.alt || "Image";
  imageCaption.textContent = image.alt || "";
  openModal(imageModal);
});

transcriptEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-diff-copy]")) {
    const card = target.closest(".tool");
    const text = card?.dataset.outputExtra ?? "";
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    const previous = target.textContent;
    target.textContent = "Copied";
    setTimeout(() => {
      target.textContent = previous;
    }, 1200);
    return;
  }
  const copy = target.closest("[data-code-copy]");
  if (!copy) return;
  const block = copy.closest(".code-block");
  const code = block?.querySelector("pre code")?.textContent ?? "";
  if (!code) return;
  const ok = await copyText(code);
  if (!ok) return;
  const previous = copy.textContent;
  copy.textContent = "Copied";
  setTimeout(() => {
    copy.textContent = previous;
  }, 1200);
});

/* ---------------- connection ---------------- */

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${location.host}/?token=${encodeURIComponent(TOKEN)}`,
  );
  socket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });
  socket.addEventListener("close", () => {
    metaEl.textContent = "disconnected — retrying…";
    showToast("Disconnected — retrying…", "warn", true);
    pendingApproval = null;
    lastApproval = null;
    approvalLayer.hidden = true;
    resetTranscript();
    setTurnActive(false);
    setTimeout(connect, 1000);
  });
}

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  if (listening) stopVoiceInput();
  const text = inputEl.value.trim();
  if (!text || readOnly) return;
  if (attachments.some((item) => item.pending)) {
    showToast("Waiting for attachments to finish uploading…", "warn");
    return;
  }
  const slash = parseSlash(text);
  inputEl.value = "";
  inputEl.style.height = "auto";
  slashMenu.hidden = true;
  syncSendState();
  if (slash) {
    const command = findCommand(slash.name);
    if (!command) {
      showToast(`Unknown command /${slash.name} — type /help`, "error");
      return;
    }
    runCommand(command, slash.args);
    return;
  }
  clearAttachments();
  send({ type: "input", text });
});

sessionSearchEl.addEventListener("input", scheduleSessionRender);

attachButton.addEventListener("click", () => {
  if (!readOnly) fileInput.click();
});

sendEl.addEventListener("click", (event) => {
  if (!turnActive || readOnly) return;
  event.preventDefault();
  event.stopPropagation();
  stopAgent();
});

function applySpeechText() {
  inputEl.value = speechBase + speechFinal + speechInterim;
  resizeInput();
  syncSendState();
  if (inputEl.value.trimStart().startsWith("/")) updateSlashMenu();
  else slashMenu.hidden = true;
}

function stopVoiceInput() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch {
    /* already stopped */
  }
}

function startVoiceInput() {
  if (!SpeechRecognitionCtor || readOnly) return;
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  speechBase = inputEl.value;
  if (speechBase && !speechBase.endsWith(" ")) speechBase += " ";
  speechFinal = "";
  speechInterim = "";
  listening = true;
  syncSendState();

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) finalText += text;
      else interimText += text;
    }
    if (finalText) speechFinal += `${finalText} `;
    speechInterim = interimText;
    applySpeechText();
  };
  recognition.onerror = (event) => {
    const message =
      event.error === "not-allowed"
        ? "Microphone permission denied."
        : `Voice input failed: ${event.error}`;
    showToast(message, "error");
  };
  recognition.onend = () => {
    listening = false;
    recognition = null;
    speechBase = "";
    speechFinal = "";
    speechInterim = "";
    syncSendState();
  };

  try {
    recognition.start();
  } catch {
    listening = false;
    recognition = null;
    syncSendState();
    showToast("Could not start voice input.", "error");
  }
}

micButton.addEventListener("click", () => {
  if (listening) stopVoiceInput();
  else startVoiceInput();
});

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = "";
  if (files.length > 0) void attachFiles(files);
});

modelSearch.addEventListener("input", renderModelList);
modelSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveModelSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const selected = modelList.querySelectorAll(".overlay-item")[modelIndex];
    selected?.click();
  }
});
modelRefresh.addEventListener("click", refreshModelsLive);

newSessionEl.addEventListener("click", () => {
  if (readOnly) return;
  sessionSearchEl.value = "";
  send({ type: "new_session" });
  closeMobileSidebar();
});

suggestionsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || readOnly) return;
  const suggestion = target.closest(".suggestion");
  if (!suggestion) return;
  inputEl.value = suggestion.dataset.prompt ?? "";
  resizeInput();
  syncSendState();
  inputEl.focus();
});

function moveSelection(container, selector, index, delta) {
  const buttons = [...container.querySelectorAll(selector)];
  if (buttons.length === 0) return index;
  buttons[index]?.classList.remove("selected");
  const next = (index + delta + buttons.length) % buttons.length;
  buttons[next]?.classList.add("selected");
  buttons[next]?.scrollIntoView({ block: "nearest" });
  return next;
}

inputEl.addEventListener("input", () => {
  resizeInput();
  syncSendState();
  updateSlashMenu();
});

inputEl.addEventListener("keydown", (event) => {
  if (!slashMenu.hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = moveSelection(
        slashMenu,
        ".popover-item",
        slashIndex,
        event.key === "ArrowDown" ? 1 : -1,
      );
      return;
    }
    if (event.key === "Tab") {
      const command = slashItems[slashIndex];
      if (command) {
        event.preventDefault();
        inputEl.value = `/${command.name} `;
        slashMenu.hidden = true;
        syncSendState();
      }
      return;
    }
    if (event.key === "Enter") {
      const command = slashItems[slashIndex];
      if (command) {
        event.preventDefault();
        inputEl.value = "";
        slashMenu.hidden = true;
        syncSendState();
        runCommand(command);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      slashMenu.hidden = true;
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});

/* ---------------- control events ---------------- */

modelButton.addEventListener("click", (event) => {
  event.stopPropagation();
  openModelModal();
});

themeToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  if (themeMenu.hidden) openThemeMenu();
  else closePopovers();
});

workspacePathEl.addEventListener("click", (event) => {
  event.stopPropagation();
  openWorkspaceModal();
});

effortButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (effortMenu.hidden) openEffortMenu();
  else closePopovers();
});

modeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (modeMenu.hidden) openModeMenu();
  else closePopovers();
});

for (const button of themeMenu.querySelectorAll("[data-theme-mode]")) {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.themeMode);
    closePopovers();
  });
}

sessionMenu
  .querySelector('[data-session-action="rename"]')
  ?.addEventListener("click", () => {
    const target = sessionMenuTarget;
    closePopovers();
    if (target) openRenameModal(target.id, target.title);
  });

sessionMenu
  .querySelector('[data-session-action="delete"]')
  ?.addEventListener("click", () => {
    const target = sessionMenuTarget;
    closePopovers();
    if (target) openDeleteModal(target.id, target.title);
  });

for (const button of document.querySelectorAll("[data-close-modal]")) {
  button.addEventListener("click", () => {
    const layer = document.getElementById(button.dataset.closeModal);
    if (layer) closeModal(layer);
  });
}

for (const layer of document.querySelectorAll(".modal-layer")) {
  layer.addEventListener("click", (event) => {
    if (event.target === layer) closeModal(layer);
  });
}

renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = renameInput.value.trim();
  if (!title || !renameTargetId) return;
  pendingRename = { id: renameTargetId, title };
  send({ type: "rename_session", id: renameTargetId, title });
  closeModal(renameModal);
});

deleteConfirm.addEventListener("click", () => {
  if (!deleteTargetId) return;
  pendingDelete = deleteTargetId;
  send({ type: "delete_session", id: deleteTargetId });
  closeModal(deleteModal);
});

workspaceGo.addEventListener("click", () =>
  browseDirectory(workspacePathInput.value.trim()),
);
workspacePathInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    browseDirectory(workspacePathInput.value.trim());
  }
});
workspaceUp.addEventListener("click", () => {
  if (directoryListing?.parent) browseDirectory(directoryListing.parent);
});
workspaceUse.addEventListener("click", useWorkspace);

paletteInput.addEventListener("input", renderPalette);
paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = moveSelection(
      paletteList,
      ".palette-item",
      paletteIndex,
      event.key === "ArrowDown" ? 1 : -1,
    );
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const command = paletteItems[paletteIndex];
    if (command) {
      closeModal(paletteModal);
      runCommand(command);
    }
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal(paletteModal);
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(".popover")) return;
  if (
    event.target.closest(
      "#model-button, #theme-toggle, #workspace-path, #input, .session-menu-btn, #effort-button, #mode-button",
    )
  ) {
    return;
  }
  closePopovers();
});

window.addEventListener("resize", () => closePopovers());
transcriptEl.addEventListener(
  "scroll",
  () => {
    closePopovers();
    const remaining =
      transcriptEl.scrollHeight -
      transcriptEl.scrollTop -
      transcriptEl.clientHeight;
    stickToBottom = remaining <= 120;
  },
  { passive: true },
);
sessionsEl.addEventListener("scroll", () => closePopovers(), { passive: true });

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (modifier && event.key.toLowerCase() === "o") {
    event.preventDefault();
    openWorkspaceModal();
    return;
  }

  if (!approvalLayer.hidden) return;

  const openLayer = [...document.querySelectorAll(".modal-layer")].find(
    (layer) => !layer.hidden,
  );

  if (event.key === "Tab" && openLayer) {
    const focusables = [
      ...openLayer.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((item) => item.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === openLayer.querySelector(".modal"))
    ) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (event.key !== "Escape") return;
  if (openLayer) {
    event.preventDefault();
    closeModal(openLayer);
    return;
  }
  if (allPopovers().some((popover) => !popover.hidden)) {
    event.preventDefault();
    closePopovers();
    return;
  }
  if (document.body.classList.contains("sidebar-open")) {
    event.preventDefault();
    closeMobileSidebar();
    return;
  }
  if (turnActive && !readOnly) {
    event.preventDefault();
    stopAgent();
  }
});

syncSendState();
connect();
