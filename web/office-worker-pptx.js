import {
  lazyLoad,
  serveRpc,
  stateGuard,
  Transfer,
  workerAsset,
} from "./office-worker-rpc.js";

const EMU_PER_PIXEL = 9525;
const MAX_PIXELS = 3840 * 2160;
const MAX_SIDE = 16384;

let engine;
let fonts;
let state;

const loadEngine = lazyLoad(async () => {
  const [pptx, bundled] = await Promise.all([
    import(workerAsset("pptx", "dist/index.js")),
    import(workerAsset("fonts", "dist/index.js")),
  ]);
  engine = pptx;
  fonts = bundled;
  return engine;
});

const required = stateGuard(() => state, "The worker holds no presentation");

function deckFamilies(inspection) {
  const found = new Set();
  let major = "";
  let minor = "";
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.fontFamily === "string") found.add(value.fontFamily);
    if (typeof value.latin === "string") found.add(value.latin);
    if (value.majorFont?.latin) major = value.majorFont.latin;
    if (value.minorFont?.latin) minor = value.minorFont.latin;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(inspection);
  return [...found]
    .map((family) => {
      if (family.startsWith("+mj")) return major;
      if (family.startsWith("+mn")) return minor;
      if (family.startsWith("+")) return "";
      return family;
    })
    .filter(Boolean);
}

function listFamilies(list) {
  const found = new Set();
  const visit = (primitive) => {
    if (primitive.kind === "textBox") {
      for (const paragraph of primitive.paragraphs ?? []) {
        for (const run of paragraph.runs ?? []) {
          if (run.fontFamily) found.add(run.fontFamily);
        }
      }
      for (const line of primitive.lines ?? []) {
        for (const run of line.runs ?? []) {
          if (run.fontFamily) found.add(run.fontFamily);
        }
      }
    }
    for (const child of primitive.primitives ?? []) visit(child);
  };
  list.primitives.forEach(visit);
  return found;
}

async function registerFamilies(families) {
  const { handle, registered } = required();
  for (const family of families) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const key = `${family}:${bold}:${italic}`;
        if (registered.has(key)) continue;
        registered.add(key);
        const face =
          fonts.resolveMetricCompatFace(family, bold, italic) ??
          fonts.resolveBundledFamilyFace(family, bold, italic) ??
          fonts.resolveLastResortFace(family, bold, italic, "powerpoint");
        if (!face) continue;
        const bytes = await fonts.loadBundledFontBytes(face);
        handle.registerFont({
          family,
          bold,
          italic,
          bytes: new Uint8Array(bytes),
        });
        if ("fonts" in self) {
          const browserFace = new FontFace(family, bytes, {
            weight: bold ? "700" : "400",
            style: italic ? "italic" : "normal",
          });
          self.fonts.add(await browserFace.load());
        }
      }
    }
  }
}

serveRpc({
  async open({ bytes }) {
    const api = await loadEngine();
    await api.initWasm();
    const handle = api.openPresentation(new Uint8Array(bytes));
    const snapshot = handle.snapshot();
    state = {
      handle,
      surface: new OffscreenCanvas(1, 1),
      pictures: new Map(),
      registered: new Set(),
    };
    await registerFamilies(
      deckFamilies(api.inspectPresentation(new Uint8Array(bytes))),
    );
    const fallback = fonts.resolveLastResortFace(
      "",
      false,
      false,
      "powerpoint",
    );
    if (fallback) {
      handle.registerFallbackFont({
        family: "sans-serif",
        bytes: new Uint8Array(await fonts.loadBundledFontBytes(fallback)),
      });
    }
    const width = snapshot.widthEmu / EMU_PER_PIXEL;
    const height = snapshot.heightEmu / EMU_PER_PIXEL;
    return snapshot.slides.map(() => ({ width, height }));
  },
  async paint({ index, density }, signal) {
    const api = engine;
    const { handle, surface, pictures } = required();
    let list = handle.layoutSlide(index);
    await registerFamilies(listFamilies(list));
    list = handle.layoutSlide(index);
    if (signal.aborted) return { kind: "cancelled" };
    const scale = Math.min(
      density,
      Math.sqrt(MAX_PIXELS / (list.width * list.height)),
      MAX_SIDE / Math.max(list.width, list.height),
    );
    const canvas = surface;
    const width = Math.max(1, Math.round(list.width * scale));
    const height = Math.max(1, Math.round(list.height * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { kind: "failed" };
    context.reset();

    const resolveImage = async (asset) => {
      if (signal.aborted) return null;
      const cached = pictures.get(asset);
      if (cached) return cached;
      const blob = api.presentationImageBlob(handle.mediaBytes(asset));
      const bitmap = api.needsElementDecode(blob)
        ? null
        : await createImageBitmap(blob).catch(() => null);
      pictures.set(asset, bitmap);
      return bitmap;
    };

    try {
      await api.paintSlide(context, list, scale, 1, {
        resolveImage,
        maxShadowPixels: width * height * 16,
      });
    } catch {
      return { kind: "failed" };
    }
    if (signal.aborted) return { kind: "cancelled" };
    const bitmap = canvas.transferToImageBitmap();
    return new Transfer({ kind: "painted", bitmap }, [bitmap]);
  },
});
