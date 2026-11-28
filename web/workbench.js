import { fileKind, hasWorkspaceDrag, readWorkspaceDrag } from "./files.js";

const TAB_KINDS = {
  file: { icon: "i-file", title: "File" },
  pdf: { icon: "i-file", title: "PDF" },
  terminal: { icon: "i-terminal", title: "Terminal" },
  review: { icon: "i-diff", title: "Review" },
  tasks: { icon: "i-tasks", title: "Tasks" },
  "new-tab": { icon: "i-plus", title: "New tab" },
};

const RECENT_LIMIT = 12;
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 280;
const MAX_WIDTH = 620;

export function createWorkbench(deps) {
  const registry = new Map();
  const paneHosts = new Map();
  const tabs = [];
  const recent = [];
  const listeners = new AbortController();
  const { signal } = listeners;

  let activeId = null;
  let width = DEFAULT_WIDTH;
  let workspace = deps.getWorkspace();
  let returnFocus = null;
  let sequence = 0;
  let restoreGeneration = 0;
  let dragging = false;
  let dropActive = false;

  const element = document.createElement("aside");
  element.className = "wb-dock";
  element.id = "wb-dock";
  element.hidden = true;
  element.setAttribute("aria-label", "Workbench");
  element.innerHTML = `
    <div class="wb-resizer" role="separator" aria-orientation="vertical"
         aria-label="Resize workbench" tabindex="0"></div>
    <div class="wb-tabs" role="tablist" aria-label="Workbench tabs"></div>
    <div class="wb-panes"></div>
  `;

  const strip = element.querySelector(".wb-tabs");
  const paneHost = element.querySelector(".wb-panes");
  const resizer = element.querySelector(".wb-resizer");

  const dropHint = document.createElement("div");
  dropHint.className = "wb-drop";
  dropHint.hidden = true;
  dropHint.setAttribute("role", "status");
  dropHint.innerHTML =
    '<svg class="icon" aria-hidden="true"><use href="#i-file"></use></svg><span>Drop to preview in workbench</span>';
  element.append(dropHint);

  function clearDrop() {
    toggle.classList.remove("is-drop-target");
    if (!dropActive) return;
    dropActive = false;
    dropHint.hidden = true;
    element.classList.remove("is-drop-target");
  }

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "wb-plus";
  plus.title = "New tab";
  plus.setAttribute("aria-label", "New tab");
  plus.textContent = "+";
  plus.addEventListener("click", () => showNewTab(), { signal });

  const scrim = document.createElement("div");
  scrim.className = "wb-scrim";
  scrim.hidden = true;
  scrim.addEventListener("click", () => setOpen(false), { signal });
  document.body.append(scrim);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-btn wb-toggle";
  toggle.setAttribute("aria-label", "Open workbench");
  toggle.setAttribute("aria-controls", element.id);
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Workbench (Ctrl+Shift+R)";
  toggle.innerHTML =
    '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg>';
  toggle.addEventListener("click", () => setOpen(element.hidden), { signal });
  const toggleHost = deps.toggleHost ?? document.querySelector(".head-right");
  toggleHost?.append(toggle);

  function storageKey(name) {
    return `atom-lite.workbench.${encodeURIComponent(workspace)}.${name}`;
  }

  function readJSON(name, fallback) {
    try {
      const raw = deps.storage.get(storageKey(name));
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJSON(name, value) {
    try {
      deps.storage.set(storageKey(name), JSON.stringify(value));
    } catch {
      // Storage can be unavailable or full; the session still works in memory.
    }
  }

  function layout() {
    return { tabs, activeId, width };
  }

  function persist() {
    writeJSON("layout", layout());
    writeJSON("recent", recent);
  }

  function clampWidth(value) {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
  }

  function setWidth(value, save = false) {
    width = clampWidth(value);
    element.style.setProperty("--wb-width", `${width}px`);
    if (save) writeJSON("layout", layout());
  }

  function isOverlay() {
    return window.matchMedia("(max-width: 1024px)").matches;
  }

  function setOpen(open) {
    if (open === !element.hidden) return;
    if (open) {
      returnFocus = document.activeElement;
      syncWorkspace();
    }
    element.hidden = !open;
    scrim.hidden = !open || !isOverlay();
    document.body.classList.toggle("wb-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", `${open ? "Close" : "Open"} workbench`);
    writeJSON("open", open);
    if (open) focusActiveTab();
    else if (returnFocus?.isConnected) returnFocus.focus();
    else toggle.focus();
  }

  function toggleOpen() {
    setOpen(element.hidden);
  }

  function nextId() {
    sequence += 1;
    return `wb-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function kindInfo(kind) {
    return TAB_KINDS[kind] ?? { icon: "i-file", title: kind };
  }

  function iconElement(kind) {
    const icon = document.createElement("span");
    icon.className = "wb-tab-icon";
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${kindInfo(kind).icon}`);
    svg.append(use);
    icon.append(svg);
    return icon;
  }

  function tabTitle(tab) {
    return tab.title || kindInfo(tab.kind).title;
  }

  function registerTabType(kind, factory) {
    if (typeof kind !== "string" || typeof factory !== "function") return;
    registry.set(kind, factory);
    for (const tab of tabs) {
      if (tab.kind !== kind) continue;
      const host = paneHosts.get(tab.id);
      if (host?.dataset.missing !== "true") continue;
      host.remove();
      paneHosts.delete(tab.id);
    }
    if (!activeId) showNewTab();
    else render();
  }

  function makePane(tab) {
    const host = document.createElement("div");
    host.className = "wb-pane";
    host.id = `wb-pane-${tab.id}`;
    host.setAttribute("role", "tabpanel");
    host.setAttribute("aria-labelledby", `wb-tab-${tab.id}`);
    host.hidden = true;

    const factory = registry.get(tab.kind);
    if (!factory) {
      host.dataset.missing = "true";
      host.className = "wb-pane wb-pane-error";
      host.textContent = `No pane available for ${tab.kind} tabs.`;
    } else {
      const pane = factory(deps, tab);
      host.append(pane?.element ?? document.createTextNode(""));
      host._pane = pane;
    }
    paneHost.append(host);
    paneHosts.set(tab.id, host);
    return host;
  }

  function ensurePane(tab) {
    return paneHosts.get(tab.id) ?? makePane(tab);
  }

  function focusActiveTab() {
    strip.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }

  function showNewTab() {
    setActive(null);
    focusActiveTab();
  }

  function setActive(id, focusPane = false) {
    activeId = tabs.some((tab) => tab.id === id) ? id : null;
    for (const tab of tabs) {
      const host = ensurePane(tab);
      host.hidden = tab.id !== activeId;
    }
    newTabHost.hidden = activeId !== null;
    if (activeId !== null && focusPane)
      paneHosts.get(activeId)?._pane?.focus?.();
    renderStrip();
    persist();
  }

  function insertTab(tab, { save = true, focusPane = false } = {}) {
    restoreGeneration += 1;
    const entry = {
      id: typeof tab.id === "string" && tab.id ? tab.id : nextId(),
      kind: typeof tab.kind === "string" ? tab.kind : "file",
      title: typeof tab.title === "string" ? tab.title : "",
    };
    if (typeof tab.path === "string") entry.path = tab.path;
    if (typeof tab.terminalId === "string") entry.terminalId = tab.terminalId;
    if (tab.state && typeof tab.state === "object") entry.state = tab.state;
    tabs.push(entry);
    setActive(entry.id, focusPane);
    if (save) persist();
    return entry;
  }

  function openTab(tab = {}) {
    syncWorkspace();
    const kind = tab.kind;
    if (kind === "file" && typeof tab.path === "string") {
      const existing = tabs.find(
        (item) => item.kind === "file" && item.path === tab.path,
      );
      if (existing) {
        focusTab(existing.id);
        paneHosts.get(existing.id)?._pane?.select?.(tab.path);
        return existing;
      }
    } else if (kind === "review" || kind === "tasks") {
      const existing = tabs.find((item) => item.kind === kind);
      if (existing) {
        focusTab(existing.id);
        return existing;
      }
    }
    return insertTab(tab, { focusPane: true });
  }

  function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const [tab] = tabs.splice(index, 1);
    const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
    const hadFocus = strip.contains(document.activeElement);
    paneHosts.get(id)?._pane?.destroy?.();
    paneHosts.get(id)?.remove();
    paneHosts.delete(id);
    recent.unshift({ tab, closed: Date.now() });
    for (let i = recent.length - 1; i > 0; i -= 1) {
      if (recent[i].tab.id === id) recent.splice(i, 1);
    }
    recent.splice(RECENT_LIMIT);
    setActive(neighbour?.id ?? null);
    renderRecent();
    if (hadFocus) focusActiveTab();
  }

  function focusTab(id) {
    if (!tabs.some((tab) => tab.id === id)) return null;
    setActive(id);
    focusActiveTab();
    return tabs.find((tab) => tab.id === id);
  }

  function renameTab(id, title) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab || typeof title !== "string" || tab.title === title) return;
    tab.title = title;
    renderStrip();
    persist();
  }

  function reopen(entry) {
    if (!entry?.tab) return;
    const position = recent.indexOf(entry);
    if (position !== -1) recent.splice(position, 1);
    openTab(entry.tab);
    renderRecent();
    persist();
  }

  function openTasks() {
    const existing = tabs.find((tab) => tab.kind === "tasks");
    if (existing) {
      focusTab(existing.id);
      setOpen(true);
      return;
    }
    if (!registry.has("tasks")) return;
    setOpen(true);
    openTab({ kind: "tasks", title: "Tasks" });
  }

  function openAction(action) {
    if (action === "review") {
      setOpen(true);
      openTab({ kind: "review", title: "Review" });
    } else if (action === "terminal") {
      const count = tabs.filter((tab) => tab.kind === "terminal").length + 1;
      setOpen(true);
      openTab({
        kind: "terminal",
        title: `Terminal ${count}`,
        terminalId: nextId(),
      });
    } else if (action === "file") {
      setOpen(true);
      openTab({ kind: "file", title: "Files" });
    }
  }

  function renderStrip() {
    const buttons = tabs.map((tab) => {
      const active = tab.id === activeId;
      const row = document.createElement("div");
      row.className = "wb-tab";
      row.dataset.active = String(active);
      row.draggable = true;

      const select = document.createElement("button");
      select.type = "button";
      select.className = "wb-tab-select";
      select.id = `wb-tab-${tab.id}`;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(active));
      select.setAttribute("aria-controls", `wb-pane-${tab.id}`);
      select.tabIndex = active ? 0 : -1;
      select.title = tab.path
        ? `${tabTitle(tab)} — ${tab.path}`
        : tabTitle(tab);

      const icon = iconElement(tab.kind);

      const title = document.createElement("span");
      title.className = "wb-tab-title";
      title.textContent = tabTitle(tab);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "wb-tab-close";
      close.setAttribute("aria-label", `Close ${tabTitle(tab)}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });

      select.append(icon, title);
      select.addEventListener("click", () => focusTab(tab.id));
      row.append(select, close);
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", tab.id);
        event.dataTransfer.effectAllowed = "move";
        row.classList.add("wb-tab-dragging");
      });
      row.addEventListener("dragend", () =>
        row.classList.remove("wb-tab-dragging"),
      );
      row.addEventListener("dragover", (event) => {
        if (
          hasWorkspaceDrag(event.dataTransfer) ||
          !event.dataTransfer.types.includes("text/plain")
        )
          return;
        event.preventDefault();
        const box = row.getBoundingClientRect();
        const after = event.clientX > box.left + box.width / 2;
        row.dataset.drop = after ? "after" : "before";
      });
      row.addEventListener("dragleave", () => delete row.dataset.drop);
      row.addEventListener("drop", (event) => {
        if (hasWorkspaceDrag(event.dataTransfer)) return;
        event.preventDefault();
        reorderTab(
          event.dataTransfer.getData("text/plain"),
          tab.id,
          row.dataset.drop === "after",
        );
        delete row.dataset.drop;
      });
      return row;
    });
    strip.replaceChildren(...buttons, plus);
  }

  function reorderTab(id, targetId, after) {
    if (id === targetId) return;
    const from = tabs.findIndex((tab) => tab.id === id);
    if (from === -1) return;
    const [tab] = tabs.splice(from, 1);
    const target = tabs.findIndex((item) => item.id === targetId);
    tabs.splice(target + (after ? 1 : 0), 0, tab);
    renderStrip();
    persist();
  }

  function renderRecent() {
    recentList.replaceChildren();
    if (recent.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wb-recent-empty";
      empty.textContent = "No recently closed tabs";
      recentList.append(empty);
      return;
    }
    for (const entry of recent) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wb-recent-entry";
      const icon = iconElement(entry.tab.kind);
      const copy = document.createElement("span");
      copy.className = "wb-recent-copy";
      const title = document.createElement("strong");
      title.textContent = tabTitle(entry.tab);
      copy.append(title);
      if (entry.tab.path) {
        const path = document.createElement("small");
        path.textContent = entry.tab.path;
        copy.append(path);
      }
      const kind = document.createElement("span");
      kind.className = "wb-recent-kind";
      kind.textContent = kindInfo(entry.tab.kind).title;
      item.append(icon, copy, kind);
      item.addEventListener("click", () => reopen(entry));
      recentList.append(item);
    }
  }

  const newTabHost = document.createElement("div");
  newTabHost.className = "wb-pane wb-newtab";
  newTabHost.hidden = true;
  newTabHost.innerHTML = `
    <div class="wb-newtab-head">
      <h2>New tab</h2>
      <p>Pick where to go next.</p>
    </div>
    <div class="wb-actions">
      <button type="button" class="wb-action" data-action="review">
        <span class="wb-action-icon" aria-hidden="true"><svg class="icon"><use href="#i-diff"></use></svg></span>
        <span class="wb-action-copy"><strong>Review</strong><small>See workspace changes</small></span>
        <kbd>Ctrl+Alt+R</kbd>
      </button>
      <button type="button" class="wb-action" data-action="terminal">
        <span class="wb-action-icon" aria-hidden="true"><svg class="icon"><use href="#i-terminal"></use></svg></span>
        <span class="wb-action-copy"><strong>Terminal</strong><small>Run a shell command</small></span>
        <kbd>Ctrl+Alt+T</kbd>
      </button>
      <button type="button" class="wb-action" data-action="file">
        <span class="wb-action-icon" aria-hidden="true"><svg class="icon"><use href="#i-file"></use></svg></span>
        <span class="wb-action-copy"><strong>Open file</strong><small>Browse the workspace</small></span>
        <kbd>Ctrl+Alt+P</kbd>
      </button>
    </div>
    <section class="wb-recent">
      <h3>Recently closed</h3>
      <div class="wb-recent-list"></div>
    </section>
  `;
  const recentList = newTabHost.querySelector(".wb-recent-list");
  for (const action of newTabHost.querySelectorAll(".wb-action")) {
    action.addEventListener("click", () => openAction(action.dataset.action));
  }
  paneHost.append(newTabHost);

  function sanitizeTabs(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .filter((tab) => {
        if (!tab || typeof tab.id !== "string" || typeof tab.kind !== "string")
          return false;
        if (seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      })
      .slice(0, 40)
      .map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        title: typeof tab.title === "string" ? tab.title : "",
        ...(typeof tab.path === "string" ? { path: tab.path } : {}),
        ...(typeof tab.terminalId === "string"
          ? { terminalId: tab.terminalId }
          : {}),
        ...(tab.state && typeof tab.state === "object"
          ? { state: tab.state }
          : {}),
      }));
  }

  async function fileExists(path) {
    try {
      const response = await deps.request(
        `/file?path=${encodeURIComponent(path)}`,
      );
      return response.ok;
    } catch {
      return true;
    }
  }

  async function restore() {
    const generation = ++restoreGeneration;
    const data = readJSON("layout", {}) ?? {};
    setWidth(Number(data.width) || DEFAULT_WIDTH);
    const candidates = sanitizeTabs(data.tabs);
    const present = await Promise.all(
      candidates.map((tab) =>
        tab.kind === "file" &&
        tab.path &&
        ["text", "markdown"].includes(fileKind(tab.path))
          ? fileExists(tab.path)
          : true,
      ),
    );
    if (generation !== restoreGeneration || workspace !== deps.getWorkspace())
      return;
    tabs.push(...candidates.filter((_, index) => present[index]));
    const savedRecent = readJSON("recent", []);
    if (Array.isArray(savedRecent)) {
      for (const entry of savedRecent.slice(0, RECENT_LIMIT)) {
        const tab = sanitizeTabs([entry?.tab])[0];
        if (tab) recent.push({ tab, closed: Number(entry.closed) || 0 });
      }
    }
    activeId = tabs.some((tab) => tab.id === data.activeId)
      ? data.activeId
      : (tabs[0]?.id ?? null);
    render();
  }

  function render() {
    for (const tab of tabs) ensurePane(tab).hidden = tab.id !== activeId;
    newTabHost.hidden = activeId !== null;
    renderStrip();
    renderRecent();
  }

  function clearTabs() {
    for (const host of paneHosts.values()) {
      host._pane?.destroy?.();
      host.remove();
    }
    paneHosts.clear();
    tabs.length = 0;
    recent.length = 0;
    activeId = null;
  }

  function syncWorkspace() {
    const next = deps.getWorkspace();
    if (next === workspace) return;
    workspace = next;
    clearTabs();
    restore();
  }

  function baseName(path) {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  function openDroppedFile(path, focus) {
    const existing = tabs.find(
      (tab) => tab.kind === "file" && tab.path === path,
    );
    if (existing) {
      if (focus) focusTab(existing.id);
      return;
    }
    const tab = {
      id: `file:${deps.getWorkspace()}:${path}`,
      kind: "file",
      title: baseName(path),
      path,
    };
    if (focus) openTab(tab);
    else insertTab(tab, { focusPane: false });
  }

  async function handleDrop(target) {
    const paths = readWorkspaceDrag(target.dataTransfer, deps);
    clearDrop();
    if (paths.length === 0) return;
    setOpen(true);
    const files = paths.filter((entry) => entry.type === "file");
    const folders = paths.filter((entry) => entry.type === "dir");
    for (const path of files.slice(1).map((entry) => entry.path)) {
      openDroppedFile(path, false);
    }
    if (files.length > 0) openDroppedFile(files[0].path, true);
    if (folders.length === 0) return;
    const existing = tabs.find((tab) => tab.kind === "file");
    if (existing) focusTab(existing.id);
    else openTab({ kind: "file", title: "Files" });
    const pane = paneHosts.get(activeId)?._pane;
    await pane?.reveal?.(folders[0].path);
  }

  element.addEventListener(
    "dragover",
    (event) => {
      if (!hasWorkspaceDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      dropActive = true;
      dropHint.hidden = false;
      element.classList.add("is-drop-target");
    },
    { signal },
  );
  element.addEventListener(
    "dragleave",
    (event) => {
      if (element.contains(event.relatedTarget)) return;
      clearDrop();
    },
    { signal },
  );
  element.addEventListener(
    "drop",
    (event) => {
      if (!hasWorkspaceDrag(event.dataTransfer)) return;
      event.preventDefault();
      void handleDrop(event);
    },
    { signal },
  );
  const isComposerDrop = (target) =>
    target instanceof Element && Boolean(target.closest("#composer"));

  document.addEventListener(
    "dragover",
    (event) => {
      if (
        !element.hidden ||
        isComposerDrop(event.target) ||
        !hasWorkspaceDrag(event.dataTransfer)
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      toggle.classList.add("is-drop-target");
    },
    { signal },
  );
  document.addEventListener(
    "drop",
    (event) => {
      if (
        element.hidden &&
        !isComposerDrop(event.target) &&
        hasWorkspaceDrag(event.dataTransfer)
      ) {
        event.preventDefault();
        toggle.classList.remove("is-drop-target");
        void handleDrop(event);
      }
    },
    { signal },
  );
  document.addEventListener("dragend", clearDrop, { signal });
  document.addEventListener("drop", clearDrop, { signal });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !dropActive) return;
      clearDrop();
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true, signal },
  );

  function onKeydown(event) {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && event.shiftKey && key === "r") {
      event.preventDefault();
      toggleOpen();
      return;
    }
    if (modifier && event.shiftKey && key === "t") {
      event.preventDefault();
      reopen(recent[0]);
      return;
    }
    if (modifier && !event.shiftKey && !event.altKey && key === "j") {
      event.preventDefault();
      openTasks();
      return;
    }
    if (modifier && !event.shiftKey && !event.altKey && key === "\\") {
      const pane =
        paneHosts.get(activeId)?._pane ??
        tabs
          .filter((tab) => tab.kind === "file")
          .map((tab) => paneHosts.get(tab.id)?._pane)
          .find(Boolean);
      if (pane?.toggleTree) {
        event.preventDefault();
        pane.toggleTree();
      }
      return;
    }
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && !element.hidden) {
      const overlayOpen = [
        ...document.querySelectorAll(".modal-layer, [role=dialog]"),
      ].some((node) => !node.closest("[hidden]"));
      if (overlayOpen) return;
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!event.target?.closest?.(".wb-tab-select")) return;
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const buttons = [...strip.querySelectorAll('[role="tab"]')];
    const index = buttons.indexOf(event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
    buttons[next]?.click();
  }

  function endResize(event) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("wb-resizing");
    try {
      resizer.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have left the element.
    }
    setWidth(window.innerWidth - event.clientX, true);
  }

  resizer.addEventListener(
    "pointerdown",
    (event) => {
      dragging = true;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add("wb-resizing");
      event.preventDefault();
    },
    { signal },
  );
  resizer.addEventListener(
    "pointermove",
    (event) => {
      if (dragging) setWidth(window.innerWidth - event.clientX);
    },
    { signal },
  );
  resizer.addEventListener("pointerup", endResize, { signal });
  resizer.addEventListener("pointercancel", endResize, { signal });
  resizer.addEventListener("dblclick", () => setWidth(DEFAULT_WIDTH, true), {
    signal,
  });
  resizer.addEventListener(
    "keydown",
    (event) => {
      const step = event.shiftKey ? 48 : 16;
      const delta =
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0;
      if (!delta && event.key !== "Home") return;
      event.preventDefault();
      setWidth(event.key === "Home" ? DEFAULT_WIDTH : width + delta, true);
    },
    { signal },
  );

  const overlayQuery = window.matchMedia("(max-width: 1024px)");
  const syncOverlay = () => {
    scrim.hidden = element.hidden || !overlayQuery.matches;
  };
  overlayQuery.addEventListener("change", syncOverlay, { signal });
  document.addEventListener("keydown", onKeydown, { signal });

  function destroy() {
    listeners.abort();
    clearDrop();
    for (const host of paneHosts.values()) {
      host._pane?.destroy?.();
      host.remove();
    }
    paneHosts.clear();
    tabs.length = 0;
    recent.length = 0;
    element.remove();
    toggle.remove();
    scrim.remove();
    document.body.classList.remove("wb-open", "wb-resizing");
  }

  deps.registerTabType = registerTabType;

  const api = {
    element,
    destroy,
    openTab,
    closeTab,
    focusTab,
    renameTab,
    get activeTab() {
      return tabs.find((tab) => tab.id === activeId) ?? null;
    },
  };
  deps.openTab = api.openTab;
  deps.closeTab = api.closeTab;
  deps.focusTab = api.focusTab;
  deps.renameTab = api.renameTab;

  setWidth(width);
  restore();
  if (readJSON("open", false) === true) setOpen(true);
  return api;
}
