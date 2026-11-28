import { element, icon } from "./dom.js";
import { noPreviewCard } from "./file-card.js";
import { kindLabel } from "./file-kind.js";
import { createRpcClient } from "./office-worker-rpc.js";

const KINDS = {
  document: "docx",
  spreadsheet: "xlsx",
  presentation: "pptx",
};
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const COMPOUND_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.25;

function control(label, iconName, onClick) {
  const button = element("button", "office-control");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(iconName));
  button.addEventListener("click", onClick);
  return button;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function zoomScale(value) {
  return `scaleX(${finiteOrZero(value).toFixed(4)})`;
}

function fallbackCard(context, reason) {
  return noPreviewCard({
    name: context.name,
    size: context.size,
    detail: reason,
    kind: kindLabel(context.kind, context.path),
    path: context.path,
    token: context.deps.token,
    onCopy: async () => {
      const copied = await context.deps.copyText(context.path);
      context.deps.toast(
        copied ? "Path copied." : "Could not copy the path.",
        copied ? "info" : "error",
      );
    },
  });
}

function signatureReason(buffer) {
  const head = new Uint8Array(buffer.slice(0, 8));
  if (
    head.length > 4 &&
    head[0] === ZIP_SIGNATURE[0] &&
    head[1] === ZIP_SIGNATURE[1] &&
    head[2] === ZIP_SIGNATURE[2] &&
    head[3] === ZIP_SIGNATURE[3]
  )
    return undefined;
  if (
    head.length === COMPOUND_SIGNATURE.length &&
    COMPOUND_SIGNATURE.every((byte, index) => head[index] === byte)
  )
    return "This file is password-protected or saved in an older Office format.";
  return "This file is not a valid Office document.";
}

async function loadBytes(context, signal) {
  const response = await context.deps.request(
    `/download?path=${encodeURIComponent(context.path)}`,
    { signal },
  );
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response.arrayBuffer();
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function registerOfficePreviews(deps) {
  for (const kind of Object.keys(KINDS)) {
    deps.registerPreview(kind, (context) =>
      createOfficeViewer({ ...context, deps, kind }),
    );
  }
}

function createOfficeViewer(context) {
  const engineName = KINDS[context.kind];
  const root = element("div", `office-view office-view--${context.kind}`);
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", `${context.name} preview`);
  const toolbar = element("div", "office-toolbar");
  const stage = element("div", "office-stage");
  stage.tabIndex = 0;
  root.append(toolbar, stage);

  const loading = element("div", "office-loading");
  loading.setAttribute("role", "status");
  loading.append(
    element("span", "office-loading-bar"),
    element("span", "office-loading-bar"),
    element("span", "office-loading-bar"),
    element(
      "span",
      "office-loading-text",
      `Loading ${kindLabel(context.kind, context.path).toLowerCase()}…`,
    ),
  );
  stage.append(loading);

  const controller = new AbortController();
  let rpc;
  let destroyed = false;
  let renderId = 0;
  let current = 0;
  let zoom = 1;
  let pages = [];
  let tabs = [];
  let scrollX = 0;
  let scrollY = 0;
  let contentWidth = 0;
  let contentHeight = 0;
  let resizeObserver;
  let previousButton;
  let nextButton;
  let position;
  let zoomLabel;
  let tabStrip;

  const fail = (reason) => {
    if (destroyed) return;
    renderId += 1;
    rpc?.close();
    rpc = undefined;
    resizeObserver?.disconnect();
    toolbar.hidden = true;
    stage.replaceChildren(fallbackCard(context, reason));
  };

  const updateControls = (total, singular) => {
    if (position)
      position.textContent = `${singular} ${current + 1} of ${total}`;
    if (previousButton) previousButton.disabled = current === 0;
    if (nextButton) nextButton.disabled = current >= total - 1;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };

  const navigate = (delta, total, render) => {
    const next = clamp(current + delta, 0, total - 1);
    if (next === current) return;
    current = next;
    render();
  };

  const setZoom = (value, render) => {
    zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
    render();
  };

  const buildToolbar = (unit, render, extra) => {
    previousButton = control(
      "Previous " + unit.toLowerCase(),
      "chevron-left",
      () => navigate(-1, pages.length || tabs.length, render),
    );
    nextButton = control("Next " + unit.toLowerCase(), "chevron-right", () =>
      navigate(1, pages.length || tabs.length, render),
    );
    position = element("span", "office-position");
    const zoomOut = control("Zoom out", "zoom-out", () =>
      setZoom(zoom / 1.25, render),
    );
    zoomLabel = element("span", "office-zoom-label");
    const zoomIn = control("Zoom in", "zoom-in", () =>
      setZoom(zoom * 1.25, render),
    );
    const fit = control("Fit to width", "fit", () => {
      const width = pages[current]?.width ?? 1;
      setZoom(
        context.kind === "spreadsheet"
          ? 1
          : clamp((stage.clientWidth - 48) / width, MIN_ZOOM, MAX_ZOOM),
        render,
      );
    });
    const navigation = element("div", "office-nav");
    navigation.append(previousButton, position, nextButton);
    const zoomControls = element("div", "office-zoom");
    zoomControls.append(zoomOut, zoomLabel, zoomIn, fit);
    toolbar.append(navigation, zoomControls);
    if (extra) toolbar.append(extra);
  };

  const bitmapCanvas = (bitmap, cssWidth, cssHeight) => {
    const canvas = element("canvas", "office-canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const draw = canvas.getContext("2d");
    if (!draw) {
      bitmap.close();
      throw new Error("Canvas is unavailable in this browser");
    }
    draw.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  };

  const renderDocument = async () => {
    const id = ++renderId;
    const page = pages[current];
    if (!page || !rpc) return;
    updateControls(pages.length, "Page");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    try {
      const bitmap = await rpc.call(
        "paint",
        { index: current, scale: zoom, ratio },
        { signal: controller.signal },
      );
      if (!bitmap || destroyed || id !== renderId) {
        bitmap?.close();
        return;
      }
      const holder = element("div", "office-page");
      holder.style.width = `${page.width * zoom}px`;
      holder.style.height = `${page.height * zoom}px`;
      const canvas = bitmapCanvas(
        bitmap,
        page.width * zoom,
        page.height * zoom,
      );
      const layer = element("div", "office-page-text");
      const spans = await rpc.call(
        "text",
        { index: current },
        {
          signal: controller.signal,
        },
      );
      if (destroyed || id !== renderId) return;
      for (const span of spans ?? []) {
        const text = element("span", "office-text-span", span.text);
        text.style.left = `${finiteOrZero(span.left) * 100}%`;
        text.style.top = `${finiteOrZero(span.top) * 100}%`;
        text.style.fontSize = `${finiteOrZero(span.size) * 100}cqw`;
        text.style.transform = zoomScale(
          span.transform?.match(/scaleX\(([-\d.]+)\)/)?.[1] ?? 1,
        );
        if (span.dir === "rtl") text.dir = "rtl";
        if (span.after === "tab") text.append(element("span", "", "\t"));
        else if (span.after === "br") text.append(element("br"));
        layer.append(text);
      }
      holder.append(canvas, layer);
      stage.replaceChildren(holder);
    } catch (error) {
      if (!destroyed && id === renderId)
        fail(error?.message ?? "Could not render this page");
    }
  };

  const themeColor = (name) =>
    getComputedStyle(stage).getPropertyValue(name).trim();

  const drawSheetHeaders = (
    draw,
    grid,
    ratio,
    headerWidth,
    headerHeight,
    viewWidth,
    viewHeight,
  ) => {
    if (!grid) return;
    draw.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw.fillStyle = themeColor("--office-header");
    draw.fillRect(0, 0, headerWidth + viewWidth, headerHeight);
    draw.fillRect(0, 0, headerWidth, headerHeight + viewHeight);
    draw.font = "11px ui-sans-serif, system-ui, sans-serif";
    draw.textAlign = "center";
    draw.textBaseline = "middle";
    draw.fillStyle = themeColor("--office-header-text");
    grid.colOffsets.slice(0, -1).forEach((offset, index) => {
      const track = grid.colIndices?.[index] ?? grid.startCol + index;
      draw.fillText(
        columnName(track),
        headerWidth + (offset + grid.colOffsets[index + 1]) / 2,
        headerHeight / 2,
      );
    });
    grid.rowOffsets.slice(0, -1).forEach((offset, index) => {
      const track = grid.rowIndices?.[index] ?? grid.startRow + index;
      draw.fillText(
        String(track + 1),
        headerWidth / 2,
        headerHeight + (offset + grid.rowOffsets[index + 1]) / 2,
      );
    });
    draw.strokeStyle = themeColor("--office-grid");
    draw.lineWidth = 1;
    draw.beginPath();
    draw.moveTo(0, headerHeight + 0.5);
    draw.lineTo(headerWidth + viewWidth, headerHeight + 0.5);
    draw.moveTo(headerWidth + 0.5, 0);
    draw.lineTo(headerWidth + 0.5, headerHeight + viewHeight);
    draw.stroke();
  };

  const renderSpreadsheet = async () => {
    const id = ++renderId;
    if (!rpc) return;
    updateControls(tabs.length, "Sheet");
    const headerWidth = 36;
    const headerHeight = 20;
    const ratio = Math.min(2, window.devicePixelRatio || 1) * zoom;
    const viewWidth = Math.max(
      80,
      Math.round(stage.clientWidth / zoom - headerWidth),
    );
    const viewHeight = Math.max(
      80,
      Math.round(stage.clientHeight / zoom - headerHeight),
    );
    try {
      const frame = await rpc.call(
        "frame",
        {
          sheet: current,
          x: scrollX,
          y: scrollY,
          width: viewWidth,
          height: viewHeight,
          ratio,
        },
        { signal: controller.signal },
      );
      if (destroyed || id !== renderId) {
        frame?.bitmap?.close();
        return;
      }
      const holder = element("div", "office-sheet-scroll");
      if (!frame?.bitmap) {
        holder.append(
          element("p", "office-empty", "This sheet has no cells to show."),
        );
        stage.replaceChildren(holder);
        return;
      }
      const canvas = element("canvas", "office-canvas");
      canvas.width = Math.ceil((headerWidth + viewWidth) * ratio);
      canvas.height = Math.ceil((headerHeight + viewHeight) * ratio);
      canvas.style.width = `${(headerWidth + viewWidth) * zoom}px`;
      canvas.style.height = `${(headerHeight + viewHeight) * zoom}px`;
      const draw = canvas.getContext("2d");
      if (!draw) {
        frame.bitmap.close();
        throw new Error("Canvas is unavailable in this browser");
      }
      draw.drawImage(frame.bitmap, headerWidth * ratio, headerHeight * ratio);
      frame.bitmap.close();
      drawSheetHeaders(
        draw,
        frame.grid,
        ratio,
        headerWidth,
        headerHeight,
        viewWidth,
        viewHeight,
      );
      holder.append(canvas);
      holder.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          scrollX = clamp(
            scrollX + event.deltaX / zoom,
            0,
            Math.max(0, contentWidth - viewWidth),
          );
          scrollY = clamp(
            scrollY + event.deltaY / zoom,
            0,
            Math.max(0, contentHeight - viewHeight),
          );
          void renderSpreadsheet();
        },
        { passive: false },
      );
      stage.replaceChildren(holder);
    } catch (error) {
      if (!destroyed && id === renderId)
        fail(error?.message ?? "Could not render this sheet");
    }
  };

  const renderSlide = async () => {
    const id = ++renderId;
    const slide = pages[current];
    if (!slide || !rpc) return;
    updateControls(pages.length, "Slide");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    try {
      const painted = await rpc.call(
        "paint",
        { index: current, density: ratio * zoom },
        { signal: controller.signal },
      );
      if (destroyed || id !== renderId) {
        painted?.bitmap?.close();
        return;
      }
      if (painted?.kind !== "painted") {
        stage.replaceChildren(
          element("p", "office-empty", "This slide could not be rendered."),
        );
        return;
      }
      const holder = element("div", "office-slide");
      holder.append(
        bitmapCanvas(painted.bitmap, slide.width * zoom, slide.height * zoom),
      );
      stage.replaceChildren(holder);
    } catch (error) {
      if (!destroyed && id === renderId)
        fail(error?.message ?? "Could not render this slide");
    }
  };

  const start = async () => {
    try {
      const bytes = await loadBytes(context, controller.signal);
      if (destroyed) return;
      const reason = signatureReason(bytes);
      if (reason) {
        fail(reason);
        return;
      }
      const worker = new Worker(
        new URL(
          `/office-worker-${engineName}.js?token=${encodeURIComponent(context.deps.token)}`,
          location.origin,
        ),
        { type: "module" },
      );
      rpc = createRpcClient(worker, () =>
        fail("The Office engine stopped unexpectedly"),
      );
      const opened = await rpc.call(
        "open",
        { bytes },
        {
          signal: controller.signal,
          transfer: [bytes],
        },
      );
      if (destroyed) return;

      if (context.kind === "document") {
        const step = await rpc.call("layout", undefined, {
          signal: controller.signal,
        });
        if (destroyed) return;
        pages = step.done ? step.pages : opened.pages;
        zoom = clamp(
          (stage.clientWidth - 32) / (pages[0]?.width || 1),
          MIN_ZOOM,
          1,
        );
        buildToolbar("Page", renderDocument);
        stage.tabIndex = 0;
        await renderDocument();
      } else if (context.kind === "presentation") {
        pages = opened;
        zoom = clamp(
          (stage.clientWidth - 32) / (pages[0]?.width || 1),
          MIN_ZOOM,
          1,
        );
        buildToolbar("Slide", renderSlide);
        await renderSlide();
      } else {
        tabs = opened.tabs;
        contentWidth = opened.layout?.info?.contentWidth ?? 0;
        contentHeight = opened.layout?.info?.contentHeight ?? 0;
        current = Math.max(
          0,
          tabs.findIndex(
            (tab) => tab.index === opened.layout?.info?.activeSheet,
          ),
        );
        tabStrip = element("div", "office-sheet-tabs");
        tabStrip.setAttribute("role", "tablist");
        tabStrip.setAttribute("aria-label", "Sheets");
        tabs.forEach((tab, index) => {
          const button = element("button", "office-sheet-tab", tab.name);
          button.type = "button";
          button.setAttribute("role", "tab");
          button.addEventListener("click", async () => {
            if (!rpc || current === index) return;
            const previous = current;
            current = index;
            updateControls(tabs.length, "Sheet");
            syncTabs();
            try {
              await rpc.call(
                "show",
                { sheet: tab.index },
                {
                  signal: controller.signal,
                },
              );
            } catch {
              current = previous;
            }
            syncTabs();
            void renderSpreadsheet();
          });
          tabStrip.append(button);
        });
        const syncTabs = () => {
          [...tabStrip.children].forEach((button, index) => {
            button.setAttribute("aria-selected", String(index === current));
            button.classList.toggle("is-active", index === current);
          });
        };
        buildToolbar("Sheet", renderSpreadsheet, tabStrip);
        syncTabs();
        await renderSpreadsheet();
      }
      resizeObserver = new ResizeObserver(() => {
        if (!destroyed && context.kind === "spreadsheet")
          void renderSpreadsheet();
      });
      resizeObserver.observe(stage);
    } catch (error) {
      if (!destroyed) {
        fail(
          error?.name === "AbortError"
            ? "Preview loading was cancelled."
            : (error?.message ?? "Could not open this Office file"),
        );
      }
    }
  };

  stage.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" && nextButton && !nextButton.disabled) {
      nextButton.click();
      event.preventDefault();
    } else if (
      event.key === "ArrowLeft" &&
      previousButton &&
      !previousButton.disabled
    ) {
      previousButton.click();
      event.preventDefault();
    }
  });

  void start();

  return {
    element: root,
    destroy() {
      destroyed = true;
      controller.abort();
      renderId += 1;
      resizeObserver?.disconnect();
      rpc?.close();
      rpc = undefined;
    },
  };
}
