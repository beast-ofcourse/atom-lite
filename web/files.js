import { element, icon } from "./dom.js";
import { recordWorkspacePath, startPathDrag } from "./file-drag.js";
import { noPreviewCard, formatSize } from "./file-card.js";
import { fileKind, kindLabel, languageForPath } from "./file-kind.js";
import {
  createImagePreview,
  createMarkdownPreview,
  createMediaPreview,
  requestFullscreen,
} from "./file-previews.js";

const DIVIDER_KEY = "atom-lite.web.files-divider";
const TREE_KEY = "atom-lite.web.files-tree";
const DIVIDER_DEFAULT = 200;
const DIVIDER_MIN = 120;
const DIVIDER_MAX = 560;
const PREVIEW_MIN = 180;

const openTabs = new WeakMap();
const previews = new Map();
const hooked = new WeakSet();

export function sortTreeEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function matchesPathFilter(path, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const lower = path.toLowerCase();
  if (needle.includes("/")) return lower.includes(needle);
  return lower.split(/[\\/]/).some((segment) => segment.includes(needle));
}

function baseName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function parentPath(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fallbackPdfPreview(context) {
  return {
    element: noPreviewCard({
      name: context.name,
      size: context.size,
      detail:
        "PDF preview loads in a PDF tab. Open this file as a PDF to read and annotate it.",
    }),
  };
}

export function registerFiles(deps) {
  deps.registerTabType("file", createFilesPane);
  if (!hooked.has(deps)) {
    hooked.add(deps);
    const register = deps.registerPreview?.bind(deps);
    // Mirror later registrations (notably the PDF viewer) into this pane's lookup.
    deps.registerPreview = (type, factory) => {
      previews.set(type, factory);
      register?.(type, factory);
    };
  }
  // The PDF module publishes here when it registers before this hook exists.
  const pdfPreview = deps.pdfPreviewFactory ?? fallbackPdfPreview;
  previews.set("application/pdf", pdfPreview);
  deps.registerPreview("application/pdf", pdfPreview);
}

export function createFilesPane(deps, tab) {
  const root = element("div", "files-pane");
  const treePane = element("div", "files-tree-pane");
  const divider = element("div", "files-divider");
  const previewPane = element("div", "files-preview");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "Resize file tree");
  divider.setAttribute("aria-valuemin", String(DIVIDER_MIN));
  divider.setAttribute("aria-valuemax", String(DIVIDER_MAX));
  divider.setAttribute("aria-valuenow", String(DIVIDER_DEFAULT));
  divider.tabIndex = 0;

  const rootLabel = element("div", "files-root");
  const filter = element("input", "files-filter");
  filter.type = "search";
  filter.placeholder = "Filter files…";
  filter.setAttribute("aria-label", "Filter files");
  const tree = element("div", "files-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Workspace files");
  tree.tabIndex = 0;
  const truncation = element("div", "files-truncation", "Listing truncated");
  truncation.hidden = true;
  const empty = element("div", "files-tree-empty", "No matching files");
  empty.hidden = true;
  treePane.append(rootLabel, filter, tree, truncation, empty);

  const previewHead = element("div", "files-preview-head");
  const titleWrap = element("div", "files-preview-title");
  const nameLabel = element("span", "files-preview-name");
  const metaLabel = element("span", "files-preview-meta");
  titleWrap.append(nameLabel, metaLabel);
  const sourceButton = element(
    "button",
    "files-action files-mode-action",
    "Source",
  );
  const editButton = element("button", "files-action", "Edit");
  const saveButton = element("button", "files-action", "Save");
  const cancelButton = element("button", "files-action", "Cancel");
  for (const button of [sourceButton, editButton, saveButton, cancelButton]) {
    button.type = "button";
  }
  const previewTreeToggle = element(
    "button",
    "icon-btn files-preview-tree-toggle",
  );
  previewTreeToggle.type = "button";
  previewTreeToggle.append(icon("panel"));
  previewTreeToggle.addEventListener("click", () => setCollapsed(false));

  previewHead.append(
    previewTreeToggle,
    titleWrap,
    sourceButton,
    editButton,
    saveButton,
    cancelButton,
  );
  const body = element("div", "files-preview-body");
  previewPane.append(previewHead, body);
  root.append(treePane, divider, previewPane);

  const key = `${DIVIDER_KEY}:${deps.getWorkspace()}`;
  const treeKey = `${TREE_KEY}:${deps.getWorkspace()}`;
  const stored = Number.parseInt(deps.storage.get(key) ?? "", 10);
  let dividerWidth = Number.isFinite(stored)
    ? clamp(stored, DIVIDER_MIN, DIVIDER_MAX)
    : DIVIDER_DEFAULT;
  let collapsed = deps.storage.get(treeKey) === "true";
  let dragging = false;
  let destroyed = false;
  let loadId = 0;
  let editor = null;
  let delegate = null;
  let fileController = null;
  const fullscreen = { target: null, trigger: null };
  const mediaKeys = new AbortController();
  const controllers = new Set();
  const treeLoads = new Map();
  const expanded = new Set();
  const folders = new Map([["", { entries: [], truncated: false }]]);
  const state = {
    selected: tab.path ?? "",
    file: null,
    editing: false,
    markdownSource: false,
  };

  const registry = openTabs.get(deps) ?? new Map();
  if (tab.path) registry.set(tab.path, tab.id);
  openTabs.set(deps, registry);

  function maxTreeWidth() {
    const rect = root.getBoundingClientRect();
    return rect.width > 0
      ? Math.max(DIVIDER_MIN, rect.width - PREVIEW_MIN)
      : DIVIDER_MAX;
  }

  function applyWidth() {
    const max = maxTreeWidth();
    if (!collapsed)
      treePane.style.flexBasis = `${Math.min(dividerWidth, max)}px`;
    divider.setAttribute("aria-valuemax", String(Math.round(max)));
    divider.setAttribute(
      "aria-valuenow",
      String(Math.round(Math.min(dividerWidth, max))),
    );
  }

  function applyTree() {
    root.classList.toggle("is-tree-collapsed", collapsed);
    treePane.style.flexBasis = collapsed
      ? "0px"
      : `${Math.min(dividerWidth, maxTreeWidth())}px`;
    divider.hidden = collapsed;
    previewTreeToggle.hidden = !collapsed;
    for (const button of [treeToggle, previewTreeToggle]) {
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute(
        "aria-label",
        collapsed ? "Expand workspace tree" : "Collapse workspace tree",
      );
      button.title = `${collapsed ? "Expand" : "Collapse"} workspace tree (Ctrl+\\)`;
    }
  }

  function setCollapsed(next) {
    if (collapsed === next) return;
    collapsed = next;
    applyTree();
    deps.storage.set(treeKey, String(collapsed));
    if (collapsed && treePane.contains(document.activeElement)) {
      previewTreeToggle.focus();
    }
  }

  function saveWidth() {
    deps.storage.set(key, String(Math.round(dividerWidth)));
  }

  divider.addEventListener("pointerdown", (event) => {
    dragging = true;
    root.classList.add("is-resizing");
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = root.getBoundingClientRect();
    dividerWidth = clamp(
      event.clientX - rect.left,
      DIVIDER_MIN,
      Math.max(DIVIDER_MIN, rect.width - PREVIEW_MIN),
    );
    applyWidth();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-resizing");
    saveWidth();
  };
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);
  divider.addEventListener("lostpointercapture", endDrag);
  divider.addEventListener("dblclick", () => {
    dividerWidth = DIVIDER_DEFAULT;
    applyWidth();
    saveWidth();
  });
  divider.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") dividerWidth -= step;
    else if (event.key === "ArrowRight") dividerWidth += step;
    else if (event.key === "Home") dividerWidth = DIVIDER_MIN;
    else if (event.key === "End") dividerWidth = DIVIDER_MAX;
    else return;
    const rect = root.getBoundingClientRect();
    dividerWidth = clamp(
      dividerWidth,
      DIVIDER_MIN,
      Math.max(DIVIDER_MIN, rect.width - PREVIEW_MIN),
    );
    applyWidth();
    saveWidth();
    event.preventDefault();
  });
  const treeToggle = element("button", "icon-btn files-tree-toggle");
  treeToggle.type = "button";
  treeToggle.append(icon("panel"));
  treeToggle.addEventListener("click", () => setCollapsed(!collapsed));

  rootLabel.append(
    icon("folder"),
    element("span", "", baseName(deps.getWorkspace())),
    treeToggle,
  );
  rootLabel.title = deps.getWorkspace();

  applyWidth();
  applyTree();
  requestAnimationFrame(() => {
    if (!destroyed) applyWidth();
  });

  function hasMatchingDescendant(path, query) {
    const data = folders.get(path);
    if (!data) return false;
    return data.entries.some(
      (entry) =>
        matchesPathFilter(entry.path, query) ||
        (entry.type === "dir" && hasMatchingDescendant(entry.path, query)),
    );
  }

  function isVisible(entry, query) {
    if (!query) return true;
    return (
      matchesPathFilter(entry.path, query) ||
      hasMatchingDescendant(entry.path, query)
    );
  }

  function expandAncestors(path) {
    let parent = parentPath(path);
    while (parent) {
      expanded.add(parent);
      parent = parentPath(parent);
    }
  }

  function makeRow(entry, depth, filterActive) {
    const isDir = entry.type === "dir";
    const isExpanded = filterActive || expanded.has(entry.path);
    const row = element("div", `files-row files-row-${entry.type}`);
    row.dataset.path = entry.path;
    row.title = entry.path;
    row.tabIndex = -1;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    row.style.paddingLeft = `${8 + depth * 14}px`;
    if (isDir) row.setAttribute("aria-expanded", String(isExpanded));
    else
      row.setAttribute("aria-selected", String(state.selected === entry.path));
    if (state.selected === entry.path) row.classList.add("is-selected");

    if (isDir) {
      const chevron = icon("chevron-down", "icon files-chevron");
      if (!isExpanded) chevron.classList.add("is-collapsed");
      row.append(chevron, icon("folder"));
    } else {
      row.append(icon("file"));
    }
    row.append(element("span", "files-name", entry.name));
    row.draggable = true;
    row.addEventListener("dragstart", (event) =>
      startPathDrag(event, row, entry),
    );
    row.addEventListener("click", () => {
      if (isDir) {
        if (expanded.has(entry.path)) expanded.delete(entry.path);
        else {
          expanded.add(entry.path);
          if (!folders.has(entry.path)) void loadTree(entry.path);
        }
        renderTree(entry.path);
      } else {
        void openFile(entry.path);
      }
    });
    return row;
  }

  function renderLevel(parent, depth, query, focusPath) {
    const data = folders.get(parent);
    let shown = 0;
    for (const entry of sortTreeEntries(data?.entries ?? [])) {
      if (!isVisible(entry, query)) continue;
      const row = makeRow(entry, depth, Boolean(query));
      tree.append(row);
      if (entry.path === focusPath) row.tabIndex = 0;
      shown += 1;
      if (entry.type === "dir" && (query || expanded.has(entry.path))) {
        shown += renderLevel(entry.path, depth + 1, query, focusPath);
      }
    }
    return shown;
  }

  function renderTree(focusPath) {
    const query = filter.value.trim();
    tree.replaceChildren();
    const shown = renderLevel("", 0, query, focusPath);
    if (!focusPath && shown > 0) tree.firstElementChild.tabIndex = 0;
    empty.hidden = shown > 0 || !query;
    truncation.hidden = ![...folders.values()].some((data) => data.truncated);
    if (focusPath) {
      tree.querySelector(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    }
  }

  function loadTree(path) {
    const existing = treeLoads.get(path);
    if (existing) return existing;
    const task = (async () => {
      const controller = new AbortController();
      controllers.add(controller);
      folders.set(path, {
        entries: folders.get(path)?.entries ?? [],
        loading: true,
      });
      try {
        const response = await deps.request(
          `/tree?path=${encodeURIComponent(path)}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(`Tree request failed (${response.status})`);
        const data = await response.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        folders.set(path, {
          entries,
          truncated: Boolean(data.truncated),
        });
        for (const entry of entries) {
          if (typeof entry.path !== "string") continue;
          recordWorkspacePath(deps, entry.path, {
            type: entry.type,
            size: entry.size,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        folders.set(path, { entries: [], truncated: false });
        deps.toast(`Could not load folder: ${error.message}`, "error");
      } finally {
        controllers.delete(controller);
        if (!destroyed) renderTree();
      }
    })();
    treeLoads.set(path, task);
    void task.finally(() => treeLoads.delete(path));
    return task;
  }

  async function reveal(path) {
    setCollapsed(false);
    if (filter.value.trim()) filter.value = "";
    const ancestors = [];
    for (let parent = parentPath(path); parent; parent = parentPath(parent)) {
      ancestors.unshift(parent);
    }
    for (const dir of ancestors) {
      expanded.add(dir);
      if (!folders.has(dir)) await loadTree(dir);
    }
    if (!folders.has(path)) await loadTree(path);
    if (destroyed) return;
    expanded.add(path);
    renderTree(path);
  }

  filter.addEventListener("input", () => renderTree());
  filter.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const firstFile = [...tree.querySelectorAll('[role="treeitem"]')].find(
      (row) => row.dataset.path && !row.hasAttribute("aria-expanded"),
    );
    if (firstFile) void openFile(firstFile.dataset.path);
    event.preventDefault();
  });

  tree.addEventListener("keydown", (event) => {
    const rows = [...tree.querySelectorAll('[role="treeitem"]')];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const current = rows[index];
    let target = null;
    if (event.key === "ArrowDown") target = rows[index + 1];
    else if (event.key === "ArrowUp") target = rows[index - 1];
    else if (event.key === "Home") target = rows[0];
    else if (event.key === "End") target = rows[rows.length - 1];
    else if (
      event.key === "ArrowRight" &&
      current.getAttribute("aria-expanded") === "false"
    ) {
      current.click();
    } else if (
      event.key === "ArrowLeft" &&
      current.getAttribute("aria-expanded") === "true"
    ) {
      current.click();
    } else if (event.key === "Enter") {
      current.click();
    } else return;
    if (target) {
      for (const row of rows) row.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    }
    event.preventDefault();
  });

  function setStatus(text) {
    nameLabel.textContent = state.selected
      ? baseName(state.selected)
      : "No file selected";
    nameLabel.title = state.selected;
    metaLabel.textContent = text;
  }

  function updateActions() {
    sourceButton.hidden =
      state.editing || !state.file || state.file.kind !== "markdown";
    sourceButton.textContent = state.markdownSource ? "Preview" : "Source";
    sourceButton.setAttribute(
      "aria-label",
      state.markdownSource ? "Show rendered Markdown" : "Show Markdown source",
    );
    editButton.hidden = state.editing || state.file?.kind !== "text";
    saveButton.hidden = !state.editing;
    cancelButton.hidden = !state.editing;
  }

  function showMessage(title, detail, kind) {
    const box = element(
      "div",
      kind === "empty" ? "files-empty-state" : `files-${kind}`,
    );
    box.append(icon(kind === "error" ? "x" : "file", "icon files-state-icon"));
    box.append(element("p", "files-state-title", title));
    if (detail) box.append(element("p", "files-state-detail", detail));
    body.replaceChildren(box);
  }

  function disposeDelegate() {
    delegate?.destroy?.();
    delegate = null;
  }

  function renderHighlighted(file) {
    const pre = element("pre", "files-code");
    const code = element("code", "hljs");
    const hljs = window.hljs;
    const language = languageForPath(file.path);
    if (hljs && language && hljs.getLanguage(language)) {
      try {
        code.innerHTML = hljs.highlight(file.content, {
          language,
          ignoreIllegals: true,
        }).value;
      } catch {
        code.textContent = file.content;
      }
    } else {
      code.textContent = file.content;
    }
    pre.append(code);
    return pre;
  }

  function renderNoPreview(file, detail) {
    body.append(
      noPreviewCard({
        name: baseName(file.path),
        size: file.size,
        detail: detail ?? "This file type has no preview in the workbench.",
        kind: kindLabel(file.kind, file.path),
        path: file.path,
        token: deps.token,
        onCopy: async () => {
          const copied = await deps.copyText(file.path);
          deps.toast(
            copied ? "Path copied." : "Could not copy the path.",
            copied ? "info" : "error",
          );
        },
      }),
    );
  }

  function previewError(file) {
    return (title, detail, kind) => {
      if (state.file !== file || destroyed) return;
      showMessage(title, detail, kind);
    };
  }

  function renderRegistered(file) {
    const factory = previews.get(file.kind) ?? previews.get(file.contentType);
    if (factory) {
      const result = factory({
        deps,
        tab,
        path: file.path,
        name: baseName(file.path),
        contentType: file.contentType,
        revision: file.revision,
        size: file.size,
        content: file.content,
        container: body,
      });
      if (result?.element) {
        delegate = result;
        body.append(result.element);
        return;
      }
    }
    renderNoPreview(
      file,
      `${kindLabel(file.kind, file.path)} preview unavailable.`,
    );
  }

  function renderBody() {
    updateActions();
    disposeDelegate();
    fullscreen.target = null;
    fullscreen.trigger = null;
    body.replaceChildren();
    const file = state.file;
    if (!file) {
      showMessage(
        "No file selected",
        "Choose a file in the tree to preview it.",
        "empty",
      );
      return;
    }
    if (state.editing) {
      editor = element("textarea", "files-editor");
      editor.spellcheck = false;
      editor.value = file.content ?? "";
      body.append(editor);
      editor.focus();
      return;
    }
    editor = null;
    switch (file.kind) {
      case "text":
        body.append(renderHighlighted(file));
        break;
      case "image":
        delegate = createImagePreview({
          file,
          deps,
          name: baseName(file.path),
          fullscreen,
          onError: previewError(file),
        });
        body.append(delegate.element);
        break;
      case "video":
      case "audio": {
        const preview = createMediaPreview({
          file,
          deps,
          name: baseName(file.path),
          fullscreen,
          onError: previewError(file),
        });
        if (!preview) {
          renderNoPreview(
            file,
            "This media file is larger than the 256 MB streaming limit.",
          );
          break;
        }
        delegate = preview;
        body.append(preview.element);
        break;
      }
      case "markdown":
        delegate = createMarkdownPreview({
          file,
          deps,
          source: state.markdownSource,
        });
        body.append(delegate.element);
        break;
      case "pdf":
      case "document":
      case "spreadsheet":
      case "presentation":
        renderRegistered(file);
        break;
      default:
        renderNoPreview(file);
    }
  }

  function refuseEdit(reason) {
    deps.toast(reason, "warn");
  }

  function canEdit() {
    if (deps.getReadOnly()) {
      refuseEdit("Read-only viewers cannot edit files.");
      return false;
    }
    if (deps.getMode() === "plan") {
      refuseEdit("Editing is disabled in plan mode.");
      return false;
    }
    if (state.file?.kind !== "text") {
      refuseEdit("This file cannot be edited in the browser.");
      return false;
    }
    return true;
  }

  function enterEdit() {
    if (!canEdit()) return;
    state.editing = true;
    updateActions();
    renderBody();
  }

  function cancelEdit() {
    state.editing = false;
    updateActions();
    renderBody();
  }

  async function saveEdit() {
    if (!state.editing || !canEdit()) return;
    const file = state.file;
    const content = editor.value;
    saveButton.disabled = true;
    try {
      const response = await deps.request(
        `/file?path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: file.revision, content }),
        },
      );
      if (!response.ok) {
        let detail = `Save failed (${response.status}).`;
        try {
          const data = await response.json();
          detail = data.error || data.message || detail;
        } catch {
          /* the status is enough when the response has no JSON body */
        }
        deps.toast(
          response.status === 409
            ? "File changed since it was opened. Reload before saving."
            : detail,
          "error",
        );
        return;
      }
      const data = await response.json();
      file.revision = data.revision ?? file.revision;
      file.content = content;
      state.editing = false;
      updateActions();
      renderBody();
      setStatus(`${formatSize(new Blob([content]).size)} · saved`);
      deps.toast("File saved.", "info");
    } catch (error) {
      deps.toast(`Save failed: ${error.message}`, "error");
    } finally {
      saveButton.disabled = false;
    }
  }

  editButton.addEventListener("click", enterEdit);
  cancelButton.addEventListener("click", cancelEdit);
  saveButton.addEventListener("click", () => void saveEdit());
  sourceButton.addEventListener("click", () => {
    state.markdownSource = !state.markdownSource;
    updateActions();
    renderBody();
  });

  function treeSize(path) {
    for (const data of folders.values()) {
      const entry = data.entries.find((item) => item.path === path);
      if (entry?.type === "file") return entry.size;
    }
    return undefined;
  }

  async function lookupSize(path, signal) {
    const known = treeSize(path);
    if (known != null) return known;
    const parent = parentPath(path);
    try {
      const response = await deps.request(
        `/tree?path=${encodeURIComponent(parent)}`,
        { signal },
      );
      if (!response.ok) return undefined;
      const data = await response.json();
      const entry = Array.isArray(data.entries)
        ? data.entries.find(
            (item) => item.path === path && item.type === "file",
          )
        : null;
      return entry?.size;
    } catch {
      return undefined;
    }
  }

  async function loadFile(path) {
    const id = ++loadId;
    disposeDelegate();
    state.editing = false;
    state.markdownSource = false;
    updateActions();
    setStatus("Loading…");
    showMessage("Loading…", "", "empty");
    fileController?.abort();
    const controller = new AbortController();
    fileController = controller;
    controllers.add(controller);
    try {
      const kind = fileKind(path);
      if (
        kind === "video" ||
        kind === "audio" ||
        kind === "none" ||
        kind === "document" ||
        kind === "spreadsheet" ||
        kind === "presentation"
      ) {
        if (id !== loadId || destroyed) return;
        const size = await lookupSize(path, controller.signal);
        if (id !== loadId || destroyed || controller.signal.aborted) return;
        state.file = {
          path,
          kind,
          contentType: "",
          revision: "",
          size,
          content: "",
        };
        setStatus(
          `${size != null ? `${formatSize(size)} · ` : ""}${kindLabel(kind, path)}`,
        );
        renderBody();
        return;
      }
      const response = await deps.request(
        `/file?path=${encodeURIComponent(path)}`,
        {
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(`File request failed (${response.status})`);
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      if (id !== loadId || destroyed) return;
      const revision = response.headers.get("x-file-revision") ?? "";
      const size = Number(response.headers.get("content-length")) || undefined;
      const file = {
        path,
        contentType,
        revision,
        size,
        content: "",
        kind: fileKind(path, contentType),
      };
      if (file.kind === "text" || file.kind === "markdown") {
        file.content = await response.text();
      }
      if (id !== loadId || destroyed) return;
      state.file = file;
      const detail = languageForPath(path) ?? contentType.split(";")[0];
      setStatus(
        `${formatSize(size ?? new Blob([file.content]).size)} · ${detail}`,
      );
      renderBody();
    } catch (error) {
      if (controller.signal.aborted || id !== loadId || destroyed) return;
      state.file = null;
      setStatus("Unavailable");
      showMessage(`Could not open ${baseName(path)}`, error.message, "error");
    } finally {
      controllers.delete(controller);
      if (fileController === controller) fileController = null;
    }
  }

  function showFile(path) {
    state.selected = path;
    tab.path = path;
    deps.renameTab?.(tab.id, baseName(path));
    expandAncestors(path);
    renderTree(path);
    registry.set(path, tab.id);
    openTabs.set(deps, registry);
    void loadFile(path);
  }

  async function openFile(path) {
    if (!tab.path) {
      showFile(path);
      return;
    }
    const existing = registry.get(path);
    if (existing && existing !== tab.id) {
      deps.focusTab(existing);
      return;
    }
    if (existing === tab.id) {
      showFile(path);
      return;
    }
    const id = `file:${deps.getWorkspace()}:${path}`;
    registry.set(path, id);
    deps.openTab({ id, kind: "file", title: baseName(path), path });
  }

  document.addEventListener(
    "fullscreenchange",
    () => {
      if (document.fullscreenElement) return;
      const trigger = fullscreen.trigger;
      fullscreen.trigger = null;
      if (trigger?.isConnected) trigger.focus();
    },
    { signal: mediaKeys.signal },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const current = document.fullscreenElement;
      if (current && root.contains(current)) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void document.exitFullscreen();
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "f") return;
      if (root.closest(".wb-pane")?.hidden) return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest?.(".wb-dock"))
        return;
      if (!fullscreen.target) return;
      event.preventDefault();
      event.stopPropagation();
      requestFullscreen(fullscreen.target, null, deps, fullscreen);
    },
    { capture: true, signal: mediaKeys.signal },
  );

  if (tab.path) void loadFile(tab.path);
  void loadTree("");
  renderTree();
  renderBody();
  updateActions();

  return {
    element: root,
    focus: focusFilter,
    focusFilter,
    select: showFile,
    toggleTree: () => setCollapsed(!collapsed),
    reveal,
    destroy() {
      destroyed = true;
      mediaKeys.abort();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      disposeDelegate();
      for (const [path, id] of registry) {
        if (id === tab.id) registry.delete(path);
      }
    },
  };

  function focusFilter() {
    if (collapsed) previewTreeToggle.focus();
    else filter.focus();
  }
}
