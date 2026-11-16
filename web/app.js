// Browser client for the Atom-lite web surface.
//
// Protocol (JSON over WebSocket), mirrored by src/web/protocol.ts:
//   server -> hello | event | turn_start | turn_end | input_queued
//             | approval_request | sessions | session_changed | control | error
//   client -> input | approval | list_sessions | new_session | resume_session

const TOKEN = window.__ATOM_LITE_TOKEN__ || "";
const transcriptEl = document.getElementById("transcript");
const emptyEl = document.getElementById("empty");
const metaEl = document.getElementById("meta");
const roleEl = document.getElementById("role");
const sessionsEl = document.getElementById("sessions");
const newSessionEl = document.getElementById("new-session");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const queuedEl = document.getElementById("queued");
const approvalLayer = document.getElementById("approval-layer");
const approvalTool = document.getElementById("approval-tool");
const approvalCommand = document.getElementById("approval-command");
const approvalCwd = document.getElementById("approval-cwd");

// Tool cards cap the visible tail, like the terminal caps live output. The
// full text stays in the card's data until the card is rebuilt.
const MAX_TOOL_OUTPUT_CHARS = 60_000;
const MAX_TOOL_OUTPUT_LINES = 400;

let socket = null;
let readOnly = false;
let pendingApproval = null;
let lastApproval = null;
let assistantNode = null;
let thinkingNode = null;
let currentSessionId = null;
let sessionsCache = [];
let queuedMessages = [];

/* ---------------- rendering ---------------- */

function resetTranscript() {
  transcriptEl.replaceChildren(emptyEl);
  emptyEl.hidden = false;
  assistantNode = null;
  thinkingNode = null;
  clearQueued();
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
    label.textContent = "queued:";
    item.append(label, document.createTextNode(` ${text}`));
    queuedEl.append(item);
  }
}

function clearEmpty() {
  if (emptyEl.parentNode) emptyEl.remove();
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

function addUserMessage(text) {
  clearEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const role = document.createElement("div");
  role.className = "msg-role";
  role.textContent = "you";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  wrap.append(role, body);
  transcriptEl.append(wrap);
  scrollToEnd();
}

function assistantBlock() {
  clearEmpty();
  if (!assistantNode) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-assistant";
    const role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = "atom-lite";
    const body = document.createElement("div");
    body.className = "msg-body";
    wrap.append(role, body);
    transcriptEl.append(wrap);
    assistantNode = body;
  }
  return assistantNode;
}

function endAssistantBlock() {
  assistantNode = null;
}

function showThinking(text) {
  clearEmpty();
  if (!thinkingNode) {
    const wrap = document.createElement("div");
    wrap.className = "thinking";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "thinking";
    const body = document.createElement("div");
    details.append(summary, body);
    wrap.append(details);
    transcriptEl.append(wrap);
    thinkingNode = body;
  }
  thinkingNode.textContent += text;
  scrollToEnd();
}

function endThinkingBlock() {
  thinkingNode = null;
}

function toolCard(toolCallId, name, args, status = "running") {
  clearEmpty();
  const card = document.createElement("div");
  card.className = "tool";
  card.dataset.toolCallId = toolCallId;
  card.dataset.outputText = "";
  card.dataset.outputExtra = "";

  const head = document.createElement("button");
  head.className = "tool-head";
  head.type = "button";

  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name;

  const summary = document.createElement("span");
  summary.className = "tool-summary";
  summary.textContent = summarizeArgs(args);

  const statusEl = document.createElement("span");
  statusEl.className = `tool-status ${status === "done" ? "done" : "running"}`;
  statusEl.textContent = status === "done" ? "done" : "running";

  head.append(toolName, summary, statusEl);

  const body = document.createElement("div");
  body.className = "tool-body";
  const output = document.createElement("pre");
  output.className = "tool-output";
  body.append(output);

  head.addEventListener("click", () => card.classList.toggle("tool-collapsed"));
  card.append(head, body);
  transcriptEl.append(card);
  scrollToEnd();
  return card;
}

function findToolCard(toolCallId) {
  return transcriptEl.querySelector(
    `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
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

function appendToolOutput(card, text) {
  card.dataset.outputText = (card.dataset.outputText ?? "") + text;
  renderToolOutput(card);
  scrollToEnd();
}

function appendToolExtra(card, text) {
  card.dataset.outputExtra = (card.dataset.outputExtra ?? "") + text;
  let extra = card.querySelector(".tool-extra");
  if (!extra) {
    extra = document.createElement("pre");
    extra.className = "tool-output tool-extra";
    card.querySelector(".tool-body")?.append(extra);
  }
  extra.textContent = card.dataset.outputExtra;
}

function finishToolCard(card, result) {
  if (!card.dataset.outputText && typeof result.content === "string") {
    card.dataset.outputText = result.content;
    renderToolOutput(card);
  }
  if (Array.isArray(result.diff) && result.diff.length > 0) {
    appendToolExtra(card, result.diff.join("\n"));
  }
  const status = card.querySelector(".tool-status");
  if (status) {
    status.className = `tool-status ${result.isError ? "error" : "done"}`;
    status.textContent = result.isError ? "failed" : "done";
  }
  scrollToEnd();
}

function scrollToEnd() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderHistory(events) {
  resetTranscript();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "user_message") {
      const text = textFromMessage(event.message ?? { content: event.content });
      if (text) addUserMessage(text);
    } else if (event.type === "assistant_message") {
      const message = event.message ?? {};
      const text = textFromMessage(message);
      if (text) assistantBlock().textContent += text;
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const call of calls) {
        toolCard(call.id, call.name, call.arguments, "done");
      }
      endAssistantBlock();
    } else if (event.type === "tool_result") {
      let card = findToolCard(event.toolCallId);
      if (!card) card = toolCard(event.toolCallId, event.name, {}, "done");
      finishToolCard(card, event);
    }
  }
  endAssistantBlock();
  endThinkingBlock();
  scrollToEnd();
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

function renderSessions(sessions) {
  sessionsCache = Array.isArray(sessions) ? sessions : [];
  sessionsEl.replaceChildren();
  for (const session of sessionsCache) {
    const option = document.createElement("option");
    option.value = session.id;
    const title = session.title || "Untitled session";
    const count = `${session.messageCount ?? 0} msg`;
    const updated = formatUpdatedAt(session.updatedAt);
    option.textContent = `${title} — ${count}${updated ? ` — ${updated}` : ""}`;
    sessionsEl.append(option);
  }
  if (
    currentSessionId &&
    !sessionsCache.some((s) => s.id === currentSessionId)
  ) {
    const option = document.createElement("option");
    option.value = currentSessionId;
    option.textContent = "New session";
    sessionsEl.append(option);
  }
  if (currentSessionId) sessionsEl.value = currentSessionId;
  updateSessionControls();
}

function updateSessionControls() {
  sessionsEl.disabled = readOnly || sessionsCache.length === 0;
  newSessionEl.disabled = readOnly;
}

function applySession(message) {
  currentSessionId = message.sessionId;
  renderHistory(message.history ?? []);
  renderSessions(sessionsCache);
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
      assistantBlock().textContent += event.text;
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
  roleEl.textContent = readOnly ? "read-only viewer" : "controlling";
  inputEl.disabled = readOnly;
  updateSessionControls();
  if (readOnly) {
    approvalLayer.hidden = true;
  } else if (lastApproval && !pendingApproval) {
    openApproval(lastApproval);
  }
}

function handleMessage(message) {
  switch (message.type) {
    case "hello":
      setReadOnly(message.readOnly);
      metaEl.textContent = `${message.provider} · ${message.model}`;
      applySession(message);
      send({ type: "list_sessions" });
      break;
    case "control":
      setReadOnly(message.readOnly);
      break;
    case "event":
      handleEvent(message.event);
      break;
    case "user_input":
      addUserMessage(message.text);
      break;
    case "turn_start":
      endAssistantBlock();
      endThinkingBlock();
      break;
    case "turn_end":
      endAssistantBlock();
      endThinkingBlock();
      clearQueued();
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
      renderSessions(message.sessions);
      break;
    case "session_changed":
      applySession(message);
      break;
    case "error":
      metaEl.textContent = message.message;
      break;
    default:
      break;
  }
}

function openApproval(message) {
  pendingApproval = { id: message.id, turnId: message.turnId };
  approvalTool.textContent = message.request.tool
    ? `tool: ${message.request.tool}`
    : "";
  approvalCommand.textContent = message.request.command ?? "";
  approvalCwd.textContent = message.request.cwd ?? "";
  approvalLayer.hidden = false;
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
}

for (const button of approvalLayer.querySelectorAll("[data-decision]")) {
  button.addEventListener("click", () =>
    closeApproval(button.dataset.decision),
  );
}

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
    pendingApproval = null;
    lastApproval = null;
    approvalLayer.hidden = true;
    clearQueued();
    setTimeout(connect, 1000);
  });
}

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || readOnly) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  send({ type: "input", text });
});

sessionsEl.addEventListener("change", () => {
  const id = sessionsEl.value;
  if (!id || id === currentSessionId) return;
  send({ type: "resume_session", id });
});

newSessionEl.addEventListener("click", () => {
  if (readOnly) return;
  send({ type: "new_session" });
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});

connect();
