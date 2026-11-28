import {
  hasWorkspaceDrag,
  readWorkspaceDrag,
  workspacePathSize,
} from "./files.js";

const MAX_REQUESTS = 12;
const MAX_RESULTS = 30;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TOKEN_PATTERN = /(^|\s)@([^\s@]*)$/;

export function createMentionPicker(deps, inputEl) {
  const picker = document.createElement("div");
  picker.className = "mention-picker";
  picker.id = "mention-picker";
  picker.setAttribute("role", "listbox");
  picker.setAttribute("aria-label", "Workspace files");
  picker.hidden = true;
  document.body.append(picker);

  const chipsEl = document.createElement("div");
  chipsEl.className = "mention-chips";
  chipsEl.setAttribute("aria-label", "Referenced files");
  inputEl.insertAdjacentElement("afterend", chipsEl);

  const entriesCache = new Map();
  const inFlight = new Map();
  const chips = [];
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  let token = null;
  let results = [];
  let activeIndex = 0;
  let open = false;
  let requests = 0;
  let generation = 0;
  let loadFailed = false;

  const form = inputEl.closest("form") ?? inputEl.parentElement;
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "mention-drop";
  dropOverlay.hidden = true;
  dropOverlay.setAttribute("role", "status");
  dropOverlay.innerHTML =
    '<svg class="icon" aria-hidden="true"><use href="#i-arrow-up"></use></svg><span>Drop files to add</span>';
  form.append(dropOverlay);
  let draggingOver = false;

  function clearDrag() {
    if (!draggingOver) return;
    draggingOver = false;
    dropOverlay.hidden = true;
    form.classList.remove("is-drop-target");
  }

  function close() {
    open = false;
    generation += 1;
    requests = 0;
    token = null;
    results = [];
    picker.hidden = true;
    picker.replaceChildren();
    if (inputEl.getAttribute("aria-controls") === picker.id) {
      inputEl.removeAttribute("aria-controls");
    }
    inputEl.removeAttribute("aria-activedescendant");
  }

  function position() {
    const rect = inputEl.getBoundingClientRect();
    const gap = 6;
    const above = rect.top > window.innerHeight - rect.bottom;
    const room = above
      ? rect.top - gap - 8
      : window.innerHeight - rect.bottom - gap - 8;
    picker.style.left = `${rect.left}px`;
    picker.style.width = `${rect.width}px`;
    picker.style.maxHeight = `${Math.min(320, Math.max(80, room))}px`;
    if (above) {
      picker.style.top = "auto";
      picker.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    } else {
      picker.style.bottom = "auto";
      picker.style.top = `${rect.bottom + gap}px`;
    }
  }

  async function loadEntries(dir) {
    if (entriesCache.has(dir)) return entriesCache.get(dir);
    if (inFlight.has(dir)) return inFlight.get(dir);
    if (requests >= MAX_REQUESTS) return null;
    requests += 1;
    const task = (async () => {
      try {
        const response = await deps.request(
          `/tree?path=${encodeURIComponent(dir)}`,
        );
        if (!response.ok) {
          loadFailed = true;
          return null;
        }
        const payload = await response.json();
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        entriesCache.set(dir, entries);
        return entries;
      } catch {
        loadFailed = true;
        return null;
      }
    })();
    inFlight.set(dir, task);
    void task.finally(() => inFlight.delete(dir));
    return task;
  }

  async function walk(dirPath, gen) {
    let current = "";
    for (const part of dirPath.split("/").filter(Boolean)) {
      const entries = await loadEntries(current);
      if (gen !== generation) return;
      const dir = entries?.find(
        (entry) =>
          entry.type === "dir" &&
          entry.name.toLowerCase() === part.toLowerCase(),
      );
      if (!dir) return;
      current = dir.path;
    }
    await loadEntries(current);
  }

  function collect(query) {
    const needle = query.toLowerCase();
    const seen = new Map();
    for (const entries of entriesCache.values()) {
      for (const entry of entries) seen.set(entry.path, entry);
    }
    const matches = [...seen.values()].filter((entry) =>
      entry.path.toLowerCase().includes(needle),
    );
    matches.sort(
      (a, b) =>
        (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) ||
        collator.compare(a.path, b.path),
    );
    return matches.slice(0, MAX_RESULTS);
  }

  function render() {
    picker.replaceChildren();
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
    if (results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mention-empty";
      empty.textContent = loadFailed
        ? "Could not load workspace files"
        : "No matching files";
      picker.append(empty);
      inputEl.removeAttribute("aria-activedescendant");
      return;
    }
    results.forEach((entry, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `mention-option-${index}`;
      option.className = `mention-option${index === activeIndex ? " is-active" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === activeIndex));
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => void choose(entry));

      const icon = document.createElement("span");
      icon.className = "mention-option-icon";
      icon.textContent = entry.type === "dir" ? "▸" : "·";
      const name = document.createElement("span");
      name.className = "mention-option-name";
      name.textContent = entry.name;
      const path = document.createElement("span");
      path.className = "mention-option-path";
      path.textContent = entry.path;
      option.append(icon, name, path);
      picker.append(option);
    });
    inputEl.setAttribute(
      "aria-activedescendant",
      `mention-option-${activeIndex}`,
    );
  }

  function scrollToActive() {
    picker.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  async function refresh() {
    const gen = ++generation;
    loadFailed = false;
    const query = token.query;
    const slash = query.lastIndexOf("/");
    await walk(slash < 0 ? "" : query.slice(0, slash), gen);
    if (gen !== generation || !open) return;
    results = collect(query);
    render();
  }

  function setText(value, caret) {
    inputEl.value = value;
    inputEl.setSelectionRange(caret, caret);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function replaceToken(current, replacement) {
    setText(
      current.value.slice(0, current.start) +
        replacement +
        current.value.slice(current.end),
      current.start + replacement.length,
    );
  }

  async function fileExists(path) {
    try {
      const response = await deps.request(
        `/file?path=${encodeURIComponent(path)}`,
      );
      await response.body?.cancel();
      if (!response.ok) {
        deps.toast(`File not found: ${path}`, "error");
        return false;
      }
      return true;
    } catch {
      deps.toast(`Could not read file: ${path}`, "error");
      return false;
    }
  }

  function removeChip(path) {
    const index = chips.findIndex((chip) => chip.path === path);
    if (index < 0) return;
    const [chip] = chips.splice(index, 1);
    chip.element.remove();
    const at = inputEl.value.indexOf(chip.text);
    if (at >= 0) {
      setText(
        inputEl.value.slice(0, at) + inputEl.value.slice(at + chip.text.length),
        at,
      );
    }
    if (!chips.some((entry) => entry.path === path)) {
      deps.send({ type: "remove_attachment", path });
    }
  }

  function addChip(path) {
    const element = document.createElement("span");
    element.className = "mention-chip";
    const label = document.createElement("span");
    label.className = "mention-chip-label";
    label.textContent = `@${path}`;
    label.title = path;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mention-chip-remove";
    remove.setAttribute("aria-label", `Remove reference to ${path}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeChip(path));
    element.append(label, remove);
    chipsEl.append(element);
    chips.push({ path, text: `@${path} `, element });
  }

  function pruneChips() {
    for (const chip of [...chips]) {
      if (!inputEl.value.includes(chip.text)) {
        chips.splice(chips.indexOf(chip), 1);
        chip.element.remove();
      }
    }
  }

  async function choose(entry) {
    const current = token;
    if (!current) return;
    if (entry.type === "dir") {
      replaceToken(current, `@${entry.path}/`);
      return;
    }
    close();
    if (inputEl.value !== current.value) return;
    if (!(await fileExists(entry.path))) return;
    if (inputEl.value !== current.value) return;
    replaceToken(current, `@${entry.path} `);
    addChip(entry.path);
    deps.attachFile(entry.path);
  }

  function insertDropReference(path, folder) {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(inputEl.value[start - 1]) ? " " : "";
    const text = `${prefix}@${path}${folder ? "/" : " "}`;
    setText(
      inputEl.value.slice(0, start) + text + inputEl.value.slice(end),
      start + text.length,
    );
  }

  async function addDroppedPath(entry) {
    if (deps.getReadOnly()) {
      deps.toast("Read-only viewers cannot add file references.", "warn");
      return;
    }
    close();
    const before = inputEl.value;
    try {
      if (entry.type === "dir") {
        insertDropReference(entry.path, true);
        return;
      }
      const size = workspacePathSize(deps, entry.path);
      const oversized = size != null && size > MAX_ATTACHMENT_BYTES;
      if (!oversized && !(await fileExists(entry.path))) return;
      if (inputEl.value !== before) return;
      insertDropReference(entry.path, false);
      addChip(entry.path);
      if (oversized) {
        deps.toast(
          `${entry.path} is larger than 20 MB; added as a reference only.`,
          "warn",
        );
      } else {
        deps.attachFile(entry.path);
      }
    } finally {
      inputEl.focus();
    }
  }

  function onDragOver(event) {
    if (deps.getReadOnly() || !hasWorkspaceDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    draggingOver = true;
    dropOverlay.hidden = false;
    form.classList.add("is-drop-target");
  }

  function onDragLeave(event) {
    if (!form.contains(event.relatedTarget)) clearDrag();
  }

  function onDrop(event) {
    if (!hasWorkspaceDrag(event.dataTransfer)) return;
    event.preventDefault();
    clearDrag();
    const [entry] = readWorkspaceDrag(event.dataTransfer, deps);
    if (entry) void addDroppedPath(entry);
  }

  function onInput() {
    pruneChips();
    if (deps.getReadOnly()) {
      close();
      return;
    }
    const caret = inputEl.selectionStart;
    const match =
      caret === null ? null : TOKEN_PATTERN.exec(inputEl.value.slice(0, caret));
    if (
      !match ||
      inputEl.value
        .slice(0, caret)
        .split("\n")
        .pop()
        .trimStart()
        .startsWith("/")
    ) {
      close();
      return;
    }
    token = {
      start: caret - match[2].length - 1,
      end: caret,
      value: inputEl.value,
      query: match[2],
    };
    activeIndex = 0;
    open = true;
    picker.hidden = false;
    inputEl.setAttribute("aria-controls", picker.id);
    position();
    void refresh();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && draggingOver) {
      clearDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!open || event.target !== inputEl || event.isComposing) return;
    const handled = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(
      event.key,
    );
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      close();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + results.length) % results.length;
      render();
      scrollToActive();
      return;
    }
    void choose(results[activeIndex]);
  }

  function onPointerDown(event) {
    if (!open) return;
    if (inputEl.contains(event.target) || picker.contains(event.target)) return;
    close();
  }

  inputEl.addEventListener("input", onInput);
  form.addEventListener("dragover", onDragOver);
  form.addEventListener("dragleave", onDragLeave);
  form.addEventListener("drop", onDrop);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("dragend", clearDrag);
  document.addEventListener("drop", clearDrag);

  return {
    destroy() {
      inputEl.removeEventListener("input", onInput);
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("dragleave", onDragLeave);
      form.removeEventListener("drop", onDrop);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("dragend", clearDrag);
      document.removeEventListener("drop", clearDrag);
      clearDrag();
      close();
      chipsEl.remove();
      dropOverlay.remove();
      picker.remove();
    },
  };
}
