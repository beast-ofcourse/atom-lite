const LINE_KINDS = Object.freeze({
  add: "add",
  added: "add",
  "+": "add",
  del: "del",
  deleted: "del",
  removed: "del",
  "-": "del",
  hunk: "hunk",
  header: "hunk",
  meta: "meta",
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = element("button", className, label);
  node.setAttribute("type", "button");
  node.addEventListener("click", onClick);
  return node;
}

function lineKind(type) {
  return LINE_KINDS[type] ?? "context";
}

function diffRow(type, text) {
  const kind = lineKind(type);
  const sign = kind === "add" ? "+" : kind === "del" ? "−" : " ";
  const row = element("div", `diff-line diff-${kind}`);
  const marker = element("span", "diff-sign", sign);
  marker.setAttribute("aria-hidden", "true");
  const code = element("code", "diff-text", text);
  if (kind === "add" || kind === "del") {
    row.setAttribute(
      "aria-label",
      `${kind === "add" ? "Added" : "Removed"}: ${text}`,
    );
  }
  row.append(marker, code);
  return row;
}

function hunkNode(hunk) {
  const details = element("details", "review-hunk");
  const head = element("summary", "review-hunk-head");
  const chevron = element("span", "review-chevron", "▸");
  chevron.setAttribute("aria-hidden", "true");
  head.append(
    chevron,
    element("span", "review-hunk-label", String(hunk?.header ?? "")),
  );
  const lines = element("div", "review-lines");
  for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
    lines.append(diffRow(line?.type, String(line?.text ?? "")));
  }
  details.append(head, lines);
  return details;
}

function entryNode(entry, deps) {
  const path = String(entry?.path ?? "");
  const details = element("details", "review-entry");
  details.setAttribute("data-path", path);
  const head = element("summary", "review-entry-head");
  const chevron = element("span", "review-chevron", "▸");
  chevron.setAttribute("aria-hidden", "true");
  const pathNode = element("span", "review-path", path);
  pathNode.setAttribute("title", path);
  const summary = element(
    "span",
    "review-summary",
    String(entry?.summary ?? ""),
  );
  summary.hidden = !entry?.summary;
  const stat = element("span", "diff-stat");
  stat.append(
    element("span", "diff-stat-add", `+${Number(entry?.added) || 0}`),
    element("span", "diff-stat-del", `−${Number(entry?.deleted) || 0}`),
  );
  const open = button("Open file", "review-open", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openTab({
      id: `file:${path}`,
      kind: "file",
      title: path.split("/").pop() || path,
      path,
    });
  });
  head.append(chevron, pathNode, summary, stat, open);
  const content = element("div", "review-entry-body");
  for (const hunk of Array.isArray(entry?.hunks) ? entry.hunks : []) {
    content.append(hunkNode(hunk));
  }
  details.append(head, content);
  return details;
}

function createReviewPane(deps) {
  const root = element("div", "review-pane");
  const head = element("div", "review-head");
  const count = element("span", "review-count", "Loading…");
  const refresh = button("Refresh", "review-refresh", () => load());
  head.append(element("span", "review-title", "Review"), count, refresh);

  const notice = element(
    "div",
    "review-truncated",
    "Changes truncated by the server cap — not all files or lines are shown.",
  );
  notice.setAttribute("role", "status");
  notice.hidden = true;

  const body = element("div", "review-body");
  root.append(head, notice, body);
  let controller = null;

  function render(data) {
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    notice.hidden = !data?.truncated;
    count.textContent =
      entries.length === 1 ? "1 file" : `${entries.length} files`;
    body.replaceChildren();
    if (entries.length === 0) {
      body.append(
        element("div", "review-empty", "No changes in this workspace."),
      );
      return;
    }
    for (const entry of entries) body.append(entryNode(entry, deps));
  }

  function renderError() {
    notice.hidden = true;
    count.textContent = "";
    const box = element("div", "review-error");
    box.append(
      element("div", "review-error-message", "Could not load changes."),
      button("Retry", "review-retry", () => load()),
    );
    body.replaceChildren(box);
  }

  async function load() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    count.textContent = "Loading…";
    try {
      const response = await deps.request("/diff", { signal: current.signal });
      if (!response.ok)
        throw new Error(`Diff request failed (${response.status})`);
      const data = await response.json();
      if (current.signal.aborted) return;
      render(data);
    } catch (error) {
      if (current.signal.aborted || error?.name === "AbortError") return;
      renderError();
    }
  }

  load();

  return {
    element: root,
    destroy() {
      controller?.abort();
    },
    focus() {
      refresh.focus?.();
    },
  };
}

export function registerReview(deps) {
  deps.registerTabType("review", () => createReviewPane(deps));
}
