import { drawIcon, element, icon } from "./dom.js";
import { imageUrl, mediaUrl } from "./file-urls.js";

const ZOOM_STEP = 1.25;
const MEDIA_MAX_BYTES = 256 * 1024 * 1024;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toolbarButton(label, paths, onClick) {
  const button = element("button", "files-media-tool");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(drawIcon(paths));
  button.addEventListener("click", onClick);
  return button;
}

export function requestFullscreen(target, trigger, deps, fullscreen) {
  if (!target?.requestFullscreen || document.fullscreenElement) return;
  fullscreen.trigger = trigger ?? null;
  void target.requestFullscreen().catch(() => {
    fullscreen.trigger = null;
    deps.toast("Fullscreen is unavailable for this preview.", "warn");
  });
}

export function createImagePreview({ file, deps, name, fullscreen, onError }) {
  const stage = element("div", "files-media-stage files-image-stage");
  const image = element("img", "files-image files-media");
  let fitScale = 1;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let origin = null;
  let nativeWidth = 0;
  let nativeHeight = 0;

  const loading = element("div", "files-media-loading");
  loading.setAttribute("role", "status");
  loading.append(icon("image", "icon"), element("span", "", "Loading image…"));

  function bound(value, size) {
    const limit = Math.max(0, (size * fitScale * (zoom - 1)) / 2);
    return clamp(value, -limit, limit);
  }

  function paint() {
    image.style.width = `${nativeWidth}px`;
    image.style.height = `${nativeHeight}px`;
    image.style.transform =
      `translate(-50%, -50%) translate(${panX}px, ${panY}px) ` +
      `scale(${fitScale * zoom})`;
    stage.classList.toggle("is-zoomed", zoom > 1);
  }

  function measure() {
    const width = Math.max(1, stage.clientWidth - 32);
    const height = Math.max(1, stage.clientHeight - 32);
    fitScale =
      nativeWidth && nativeHeight
        ? Math.max(
            0.01,
            Math.min(1, width / nativeWidth, height / nativeHeight),
          )
        : 1;
    panX = bound(panX, nativeWidth);
    panY = bound(panY, nativeHeight);
    paint();
  }

  const zoomLabel = element("span", "files-zoom-label", "Fit");
  zoomLabel.setAttribute("role", "status");
  function setZoom(next) {
    zoom = clamp(next, 0.5, 8);
    panX = bound(panX, nativeWidth);
    panY = bound(panY, nativeHeight);
    zoomLabel.textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
    paint();
  }

  const tools = element("div", "files-media-tools");
  tools.append(
    toolbarButton("Zoom out", ["M5 12h14"], () => setZoom(zoom / ZOOM_STEP)),
    toolbarButton("Zoom in", ["M12 5v14", "M5 12h14"], () =>
      setZoom(zoom * ZOOM_STEP),
    ),
    toolbarButton(
      "Fit image to preview",
      ["M9 4H4v5", "M15 4h5v5", "M20 15v5h-5", "M9 20H4v-5"],
      () => {
        panX = 0;
        panY = 0;
        setZoom(1);
      },
    ),
    toolbarButton(
      "View image fullscreen",
      ["M14 4h6v6", "M20 4l-7 7", "M10 20H4v-6", "M4 20l7-7"],
      (event) =>
        requestFullscreen(stage, event.currentTarget, deps, fullscreen),
    ),
    zoomLabel,
  );

  image.src = imageUrl(file.path, deps.token);
  image.alt = name;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.draggable = false;
  image.addEventListener(
    "load",
    () => {
      nativeWidth = image.naturalWidth;
      nativeHeight = image.naturalHeight;
      loading.remove();
      measure();
    },
    { once: true },
  );
  image.addEventListener("error", () =>
    onError(
      `Could not open ${name}`,
      "The image could not be loaded.",
      "error",
    ),
  );
  image.addEventListener("pointerdown", (event) => {
    if (zoom <= 1 || event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY };
    image.setPointerCapture(event.pointerId);
    image.classList.add("is-dragging");
  });
  image.addEventListener("pointermove", (event) => {
    if (!origin) return;
    panX = bound(panX + event.clientX - origin.x, nativeWidth);
    panY = bound(panY + event.clientY - origin.y, nativeHeight);
    origin = { x: event.clientX, y: event.clientY };
    paint();
  });
  const endPan = () => {
    origin = null;
    image.classList.remove("is-dragging");
  };
  image.addEventListener("pointerup", endPan);
  image.addEventListener("pointercancel", endPan);
  image.addEventListener("lostpointercapture", endPan);
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY / 240));
    },
    { passive: false },
  );

  const observer = new ResizeObserver(() => {
    if (stage.isConnected && nativeWidth) measure();
  });
  observer.observe(stage);
  fullscreen.target = stage;
  stage.append(image, loading, tools);
  return {
    element: stage,
    destroy() {
      observer.disconnect();
    },
  };
}

export function createMediaPreview({ file, deps, name, fullscreen, onError }) {
  if (file.size > MEDIA_MAX_BYTES) return null;
  const stage = element("div", "files-media-stage");
  const media = element(
    file.kind === "video" ? "video" : "audio",
    `files-media files-media-${file.kind}`,
  );
  media.controls = true;
  media.preload = "metadata";
  media.playsInline = file.kind === "video";
  media.src = mediaUrl(file.path, deps.token);
  media.setAttribute("aria-label", name);

  const loading = element("div", "files-media-loading");
  loading.setAttribute("role", "status");
  loading.append(
    icon(file.kind === "video" ? "video" : "audio", "icon"),
    element("span", "", "Loading media…"),
  );

  media.addEventListener("loadedmetadata", () => loading.remove(), {
    once: true,
  });
  media.addEventListener("error", () =>
    onError(
      `Could not play ${name}`,
      "The browser cannot decode this file.",
      "error",
    ),
  );
  if (file.kind === "video") {
    const fullscreenButton = toolbarButton(
      "View video fullscreen",
      ["M14 4h6v6", "M20 4l-7 7", "M10 20H4v-6", "M4 20l7-7"],
      (event) =>
        requestFullscreen(media, event.currentTarget, deps, fullscreen),
    );
    media.addEventListener("dblclick", () =>
      requestFullscreen(media, fullscreenButton, deps, fullscreen),
    );
    const tools = element("div", "files-media-tools");
    tools.append(fullscreenButton);
    stage.append(tools);
    fullscreen.target = media;
  }
  stage.append(media, loading);
  return { element: stage };
}

export function createMarkdownPreview({ file, deps, source }) {
  const page = element("div", "files-markdown msg-markdown");
  page.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const copy = target.closest("[data-code-copy]");
    if (!copy) return;
    const block = copy.closest(".code-block, .mermaid-block");
    const code = block?.querySelector("pre code")?.textContent ?? "";
    if (!code) return;
    void deps.copyText(code).then((ok) => {
      if (!ok || !page.isConnected) return;
      copy.textContent = "Copied";
      setTimeout(() => {
        if (page.isConnected) copy.textContent = "Copy";
      }, 1200);
    });
  });
  if (source || typeof deps.renderMarkdown !== "function") {
    const pre = element("pre", "files-code");
    const code = element("code");
    code.textContent = file.content ?? "";
    pre.append(code);
    page.append(pre);
  } else {
    page.innerHTML = deps.renderMarkdown(file.content ?? "");
  }
  if (!source && typeof deps.renderMermaidBlock === "function") {
    for (const block of page.querySelectorAll(".mermaid-block")) {
      deps.renderMermaidBlock(block);
    }
  }
  return { element: page };
}
