const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 1.25;
const ROTATIONS = [0, 90, 180, 270];

let enginePromise;

function isTab(value) {
  return Boolean(
    value && typeof value === "object" && typeof value.id === "string",
  );
}

function assetUrl(deps, name) {
  return deps.token
    ? `/vendor/${name}?token=${encodeURIComponent(deps.token)}`
    : `/vendor/${name}`;
}

function loadEngine(deps) {
  if (!enginePromise) {
    enginePromise = import(assetUrl(deps, "pdf.min.js"));
    void enginePromise.catch(() => {
      enginePromise = undefined;
    });
  }
  return enginePromise;
}

async function bytesFrom(source) {
  if (!source) return null;
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof source.arrayBuffer === "function") {
    return new Uint8Array(await source.arrayBuffer());
  }
  return null;
}

function makeButton(action, label, glyph) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-control";
  button.dataset.pdfAction = action;
  button.setAttribute("aria-label", label);
  button.textContent = glyph;
  return button;
}

export function registerPdfPreview(deps) {
  const factory = (...args) => {
    const tab = args.find(isTab) ?? {};
    const file =
      args.find((value) => value && value !== deps && value !== tab) ?? {};
    return createPdfPane(deps, tab, file);
  };

  if (typeof deps.registerTabType === "function") {
    deps.registerTabType("pdf", factory);
  }
  if (typeof deps.registerPreview === "function") {
    deps.registerPreview("application/pdf", factory);
  } else {
    deps.pdfPreviewFactory = factory;
  }
}

function createPdfPane(deps, tab, file) {
  const root = document.createElement("div");
  root.className = "pdf-viewer";
  root.dataset.pdfRotation = "0";

  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "PDF viewer controls");

  const buttons = {
    prev: makeButton("prev", "Previous page", "‹"),
    next: makeButton("next", "Next page", "›"),
    "zoom-out": makeButton("zoom-out", "Zoom out", "−"),
    "zoom-in": makeButton("zoom-in", "Zoom in", "+"),
    fit: makeButton("fit", "Fit to width", "Fit"),
    rotate: makeButton("rotate", "Rotate page", "↻"),
    download: makeButton("download", "Download PDF", "↓"),
    print: makeButton("print", "Print PDF", "⎙"),
    annotate: makeButton("annotate", "Add annotation", "Add note"),
  };
  buttons.download.disabled = true;
  buttons.print.disabled = true;

  const counter = document.createElement("span");
  counter.className = "pdf-counter";
  counter.dataset.pdfCounter = "";
  counter.setAttribute("aria-live", "polite");
  counter.textContent = "– / –";

  const zoom = document.createElement("output");
  zoom.className = "pdf-zoom";
  zoom.dataset.pdfZoom = "";
  zoom.setAttribute("aria-label", "Zoom level");
  zoom.textContent = "100%";

  toolbar.append(
    buttons.prev,
    counter,
    buttons.next,
    buttons["zoom-out"],
    zoom,
    buttons["zoom-in"],
    buttons.fit,
    buttons.rotate,
    buttons.download,
    buttons.print,
  );

  const status = document.createElement("div");
  status.className = "pdf-status";
  status.dataset.pdfStatus = "";
  status.setAttribute("role", "status");
  status.textContent = "Loading PDF…";

  const pages = document.createElement("div");
  pages.className = "pdf-pages";
  pages.tabIndex = 0;
  pages.setAttribute("aria-label", "PDF pages");

  const annotations = document.createElement("aside");
  annotations.className = "pdf-annotations";
  annotations.setAttribute("aria-label", "PDF annotations");

  const heading = document.createElement("h3");
  heading.textContent = "Annotations";
  const list = document.createElement("ul");
  list.className = "pdf-annotation-list";
  list.dataset.pdfAnnotations = "";

  const form = document.createElement("form");
  form.className = "pdf-annotation-form";

  const pageLabel = document.createElement("label");
  pageLabel.textContent = "Page";
  const pageSelect = document.createElement("select");
  pageSelect.dataset.pdfAnnotationPage = "";
  pageSelect.setAttribute("aria-label", "Annotation page");
  pageLabel.append(pageSelect);

  const textLabel = document.createElement("label");
  textLabel.textContent = "Note";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.pdfAnnotationInput = "";
  input.setAttribute("aria-label", "Annotation text");
  textLabel.append(input);

  form.append(pageLabel, textLabel, buttons.annotate);
  annotations.append(heading, list, form);

  const body = document.createElement("div");
  body.className = "pdf-body";
  body.append(pages, annotations);
  root.append(toolbar, status, body);

  const pageEntries = [];
  const timers = new Set();
  let rawBytes = new Uint8Array();
  let documentTask;
  let storageKey = "";
  let revision = file?.revision ?? tab.state?.revision ?? "";
  let notes = [];
  let scale = 1;
  let rotationIndex = 0;
  let currentPage = 1;
  let destroyed = false;
  let generation = 0;
  let scrollFrame = 0;

  function later(fn, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
  }

  function readNotes() {
    try {
      const raw = deps.storage.get(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveNotes() {
    deps.storage.set(storageKey, JSON.stringify(notes));
  }

  function renderNotes() {
    list.replaceChildren();
    if (!notes.length) {
      const empty = document.createElement("li");
      empty.className = "pdf-annotation-empty";
      empty.textContent = "No annotations yet.";
      list.append(empty);
      return;
    }
    notes.forEach((note, index) => {
      const item = document.createElement("li");
      item.dataset.pdfAnnotation = "";
      const text = document.createElement("span");
      text.textContent = `p${note.page}: ${note.text}`;
      const remove = makeButton(
        "delete-annotation",
        `Delete annotation ${index + 1}`,
        "×",
      );
      remove.addEventListener("click", () => {
        notes = notes.filter((entry) => entry.id !== note.id);
        saveNotes();
        renderNotes();
      });
      item.append(text, remove);
      list.append(item);
    });
  }

  function setPage(number) {
    currentPage = Math.min(
      Math.max(number, 1),
      Math.max(pageEntries.length, 1),
    );
    counter.textContent = `${pageEntries.length ? currentPage : "–"} / ${pageEntries.length || "–"}`;
  }

  function updateCurrentPage() {
    if (!pageEntries.length) return;
    const top = pages.getBoundingClientRect().top;
    let nearest = 1;
    let distance = Infinity;
    for (const entry of pageEntries) {
      const current = Math.abs(entry.wrapper.getBoundingClientRect().top - top);
      if (current < distance) {
        distance = current;
        nearest = Number(entry.wrapper.dataset.pdfPage);
      }
    }
    setPage(nearest);
  }

  async function renderPage(entry, renderGeneration) {
    if (entry.rendered || entry.pending) return;
    entry.pending = true;
    const rotation = ROTATIONS[rotationIndex];
    const viewport = entry.page.getViewport({
      scale,
      rotation: (rotation + entry.page.rotate) % 360,
    });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    entry.canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    entry.canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    entry.canvas.style.width = `${viewport.width}px`;
    entry.canvas.style.height = `${viewport.height}px`;
    entry.wrapper.style.minHeight = `${viewport.height}px`;
    try {
      entry.task = entry.page.render({
        canvasContext: entry.canvas.getContext("2d"),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await entry.task.promise;
      if (renderGeneration === generation && !destroyed) entry.rendered = true;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
    } finally {
      if (renderGeneration === generation) entry.pending = false;
    }
  }

  function renderVisible() {
    const bounds = pages.getBoundingClientRect();
    for (const entry of pageEntries) {
      const rect = entry.wrapper.getBoundingClientRect();
      if (rect.bottom >= bounds.top - 600 && rect.top <= bounds.bottom + 600) {
        void renderPage(entry, generation).catch((error) => {
          status.textContent = `Could not render page: ${error.message}`;
        });
      }
    }
  }

  function rerender() {
    generation += 1;
    for (const entry of pageEntries) {
      if (entry.pending) entry.task?.cancel();
      entry.pending = false;
      entry.rendered = false;
    }
    renderVisible();
  }

  function setScale(value) {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
    zoom.textContent = `${Math.round(scale * 100)}%`;
    rerender();
  }

  function goToPage(number) {
    const entry = pageEntries[number - 1];
    if (!entry) return;
    setPage(number);
    entry.wrapper.scrollIntoView({ block: "start" });
    renderVisible();
  }

  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateCurrentPage();
      renderVisible();
    });
  }

  function blobUrl() {
    return URL.createObjectURL(
      new Blob([rawBytes], { type: "application/pdf" }),
    );
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    notes.push({
      id: crypto.randomUUID?.() ?? String(Date.now()),
      page: Number(pageSelect.value) || currentPage,
      text,
    });
    input.value = "";
    saveNotes();
    renderNotes();
  });
  buttons.annotate.addEventListener("click", () => form.requestSubmit());
  buttons.prev.addEventListener("click", () => goToPage(currentPage - 1));
  buttons.next.addEventListener("click", () => goToPage(currentPage + 1));
  buttons["zoom-out"].addEventListener("click", () =>
    setScale(scale / SCALE_STEP),
  );
  buttons["zoom-in"].addEventListener("click", () =>
    setScale(scale * SCALE_STEP),
  );
  buttons.fit.addEventListener("click", () => {
    const first = pageEntries[0];
    if (!first) return;
    const width = first.page.getViewport({
      scale: 1,
      rotation: ROTATIONS[rotationIndex],
    }).width;
    setScale((pages.clientWidth - 48) / width);
  });
  buttons.rotate.addEventListener("click", () => {
    rotationIndex = (rotationIndex + 1) % ROTATIONS.length;
    root.dataset.pdfRotation = String(ROTATIONS[rotationIndex]);
    rerender();
  });
  buttons.download.addEventListener("click", () => {
    const url = blobUrl();
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = tab.title || "document.pdf";
    anchor.click();
    later(() => URL.revokeObjectURL(url), 1000);
  });
  buttons.print.addEventListener("click", () => {
    const url = blobUrl();
    const frame = document.createElement("iframe");
    frame.className = "pdf-print-frame";
    frame.src = url;
    frame.addEventListener("load", () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      later(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    });
    root.append(frame);
  });
  pages.addEventListener("scroll", onScroll, { passive: true });

  async function load() {
    try {
      const path = file?.path ?? tab.path ?? "";
      rawBytes =
        (await bytesFrom(
          file?.bytes ?? file?.data ?? file?.response ?? file?.blob,
        )) ??
        (await (async () => {
          const response = await deps.request(
            `/file?path=${encodeURIComponent(path)}`,
          );
          if (!response.ok)
            throw new Error(`request failed (${response.status})`);
          revision =
            file?.revision ??
            tab.state?.revision ??
            response.headers.get("x-file-revision") ??
            "";
          return new Uint8Array(await response.arrayBuffer());
        })());

      storageKey = `atom-lite:pdf-annotations:${deps.getWorkspace?.() ?? ""}:${path}:${revision}`;
      notes = readNotes();
      renderNotes();

      const pdfjs = await loadEngine(deps);
      pdfjs.GlobalWorkerOptions.workerSrc = assetUrl(deps, "pdf.worker.min.js");
      documentTask = pdfjs.getDocument({
        data: rawBytes.slice(),
        useSystemFonts: true,
        useWasm: false,
      });
      const pdf = await documentTask.promise;
      if (destroyed) {
        void pdf.destroy();
        return;
      }

      status.textContent = "";
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        if (destroyed) return;
        const wrapper = document.createElement("section");
        wrapper.className = "pdf-page";
        wrapper.dataset.pdfPage = String(number);
        wrapper.setAttribute("aria-label", `Page ${number}`);
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-canvas";
        wrapper.style.minHeight = `${page.getViewport({ scale: 1 }).height}px`;
        wrapper.append(canvas);
        pages.append(wrapper);
        const option = document.createElement("option");
        option.value = String(number);
        option.textContent = String(number);
        pageSelect.append(option);
        pageEntries.push({
          page,
          wrapper,
          canvas,
          rendered: false,
          pending: false,
          task: null,
        });
      }
      buttons.download.disabled = false;
      buttons.print.disabled = false;
      setPage(1);
      renderVisible();
    } catch (error) {
      if (!destroyed) {
        status.textContent = `Could not load PDF: ${error.message}`;
        buttons.annotate.disabled = true;
        renderNotes();
      }
    }
  }

  void load();

  return {
    element: root,
    focus() {
      buttons.prev.focus();
    },
    destroy() {
      destroyed = true;
      generation += 1;
      pages.removeEventListener("scroll", onScroll);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of pageEntries) {
        if (entry.pending) entry.task?.cancel();
      }
      pageEntries.length = 0;
      void documentTask?.destroy().catch(() => {});
      root.replaceChildren();
    },
  };
}
