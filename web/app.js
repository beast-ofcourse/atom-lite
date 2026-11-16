// Browser client for the Atom-lite web surface.
//
// Protocol (JSON over WebSocket):
//   server -> hello | event | turn_start | turn_end | input_queued
//             | approval_request | control | error
//   client -> input | approval

const TOKEN = window.__ATOM_LITE_TOKEN__ || "";
const transcriptEl = document.getElementById("transcript");
const emptyEl = document.getElementById("empty");
const metaEl = document.getElementById("meta");
const roleEl = document.getElementById("role");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const queuedEl = document.getElementById("queued");
const approvalLayer = document.getElementById("approval-layer");
const approvalCommand = document.getElementById("approval-command");
const approvalCwd = document.getElementById("approval-cwd");

let socket = null;
let readOnly = false;
let pendingApproval = null;
let assistantNode = null;
let thinkingNode = null;

/* ---------------- rendering ---------------- */

function clearEmpty() {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
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

function toolCard(toolCallId, name) {
  clearEmpty();
  const card = document.createElement("div");
  card.className = "tool";
  card.dataset.toolCallId = toolCallId;

  const head = document.createElement("button");
  head.className = "tool-head";
  head.type = "button";

  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name;

  const summary = document.createElement("span");
  summary.className = "tool-summary";

  const status = document.createElement("span");
  status.className = "tool-status running";
  status.textContent = "running";

  head.append(toolName, summary, status);

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

function scrollToEnd() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
      assistantBlock().textContent += event.text;
      scrollToEnd();
      break;
    case "assistant_text":
      assistantBlock().textContent += event.text;
      scrollToEnd();
      break;
    case "thinking_delta":
      showThinking(event.text);
      break;
    case "tool_call": {
      const card = toolCard(event.id, event.name);
      const summary = card.querySelector(".tool-summary");
      if (summary) summary.textContent = summarizeArgs(event.args);
      break;
    }
    case "tool_output": {
      const card = findToolCard(event.toolCallId);
      if (card) {
        const output = card.querySelector(".tool-output");
        if (output) output.textContent += event.text;
        scrollToEnd();
      }
      break;
    }
    case "tool_result": {
      const card = findToolCard(event.toolCallId);
      if (card) {
        const status = card.querySelector(".tool-status");
        if (status) {
          status.className = `tool-status ${event.isError ? "error" : "done"}`;
          status.textContent = event.isError ? "failed" : "done";
        }
      }
      break;
    }
    default:
      break;
  }
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return `$ ${args.command}`;
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.query === "string") return args.query;
  return "";
}

function handleMessage(message) {
  switch (message.type) {
    case "hello":
      readOnly = Boolean(message.readOnly);
      metaEl.textContent = `${message.provider} · ${message.model}`;
      roleEl.hidden = !readOnly;
      inputEl.disabled = readOnly;
      break;
    case "control":
      readOnly = Boolean(message.readOnly);
      roleEl.hidden = !readOnly;
      inputEl.disabled = readOnly;
      break;
    case "event":
      handleEvent(message.event);
      break;
    case "turn_start":
      endAssistantBlock();
      break;
    case "turn_end":
      endAssistantBlock();
      break;
    case "input_queued":
      queuedEl.hidden = false;
      queuedEl.textContent = `queued: ${message.text}`;
      break;
    case "approval_request":
      openApproval(message);
      break;
    case "error":
      metaEl.textContent = message.message;
      break;
    default:
      break;
  }
}

function openApproval(message) {
  pendingApproval = message.id;
  approvalCommand.textContent = message.request.command ?? "";
  approvalCwd.textContent = message.request.cwd ?? "";
  approvalLayer.hidden = false;
}

function closeApproval(decision) {
  if (pendingApproval) {
    send({ type: "approval", id: pendingApproval, decision });
  }
  pendingApproval = null;
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
    setTimeout(connect, 1000);
  });
}

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || readOnly) return;
  addUserMessage(text);
  inputEl.value = "";
  inputEl.style.height = "auto";
  send({ type: "input", text });
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
