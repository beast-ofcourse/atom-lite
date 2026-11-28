import { serveRpc, Transfer } from "./office-worker-rpc.js";

const token = new URL(self.location.href).searchParams.get("token") ?? "";
const asset = (pkg, path) =>
  `/engine/@betteroffice/${pkg}/${path}?token=${encodeURIComponent(token)}`;

let modules;
let state;

async function loadModules() {
  if (modules) return modules;
  const [yrs, editor, layout, render, fonts] = await Promise.all([
    import(asset("docx", "dist/yrs/index.mjs")),
    import(asset("docx", "dist/editor/index.mjs")),
    import(asset("docx", "dist/layout/index.mjs")),
    import(asset("docx", "dist/layout/render/index.mjs")),
    import(asset("fonts", "dist/index.js")),
  ]);
  modules = { yrs, editor, layout, render, fonts };
  return modules;
}

function bundledFonts(fonts) {
  const shipped = (face) =>
    face && !face.script?.startsWith("cjk-") ? face : undefined;
  const loader = (face) => {
    const use = shipped(face);
    return use ? () => fonts.loadBundledFontBytes(use) : undefined;
  };
  return {
    resolve: (family, bold, italic) =>
      loader(fonts.resolveMetricCompatFace(family, bold, italic)),
    resolveFamily: (family, bold, italic) =>
      loader(fonts.resolveBundledFamilyFace(family, bold, italic)),
    resolveScriptFallback: (script, bold, italic) =>
      loader(fonts.resolveScriptFallbackFace(script, bold, italic)),
    resolveLastResort: (family, bold, italic) =>
      loader(fonts.resolveLastResortFace(family, bold, italic, "word")) ??
      loader(fonts.resolveLastResortFace("", bold, italic, "word")),
  };
}

function layerMeasure() {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return { width: () => 0, ascent: 0, descent: 0 };
  context.font = "100px sans-serif";
  const metrics = context.measureText("Hg");
  return {
    width: (text) => context.measureText(text).width / 100,
    ascent: metrics.fontBoundingBoxAscent / 100,
    descent: metrics.fontBoundingBoxDescent / 100,
  };
}

async function openDocument(bytes) {
  const m = await loadModules();
  const session = await m.yrs.createYrsSession();
  const document = session.openDocx(new Uint8Array(bytes), true, {
    mediaTokens: true,
  }).document;
  const settings = document.package.settings;
  const measure = m.layout.createRustMeasureSource({
    engine: {
      registerFont: (font) => session.registerFont(font),
      registerSubstituteFont: (id, family) =>
        session.registerSubstituteFont(id, family),
      clearFonts: () => session.clearFonts(),
    },
    bundled: bundledFonts(m.fonts),
  });
  measure.setCompat(settings?.compatibilityFlags);

  const request = m.editor.buildResidentRegionLayoutRequest(document, 0, {
    themeColors: Object.fromEntries(
      Object.entries(document.package.theme?.colorScheme ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    defaultTabStopTwips: settings?.defaultTabStop ?? null,
    numericIds: {},
    mediaTokens: true,
  });
  const requirements = JSON.parse(
    session.layoutFontRequirementsJson(JSON.stringify(request)),
  );
  await measure.prepareFontRequirements(requirements);
  const measurement = measure.measurementConfigForRequirements(requirements);
  if (!measurement) throw new Error("Document fonts could not be prepared");

  const input = JSON.stringify({ ...request, measurement });
  const reply = session.layoutDocumentWithRegionsRetainedJson(input);
  const layout = m.editor.workerLayoutComputation(reply).layout;
  session.setDisplayWindow(0, layout.pages.length);
  const extras = m.render.encodeDisplayListFrameExtras({
    measured: [],
    options: undefined,
    layout,
    fontChains: measurement.fontChains,
    headersFooters: m.editor.getLayoutKernelInputs(layout)?.headersFooters,
    resolvedCommentIds: [],
  });
  let frame = m.render.applyFrameDelta(
    null,
    m.render.decodeFrameDelta(session.buildDisplayListFrame(extras, 0)),
  );
  if (frame.displayList.pages.length === 0) {
    throw new Error("Document produced no pages");
  }

  state = {
    session,
    frame,
    surface: new OffscreenCanvas(1, 1),
    glyphCache: new m.render.GlyphCache({
      provider: (font, glyph) => session.outlineGlyphJson(font, glyph),
    }),
    measure: layerMeasure(),
    projection: undefined,
  };
  return pageSizes();
}

function required() {
  if (!state) throw new Error("The worker holds no document");
  return state;
}

function built(index) {
  const { session, frame } = required();
  const page = frame.displayList.pages[index];
  if (!page?.unbuilt) return page;
  state.frame = modules.render.applyFrameDelta(
    frame,
    modules.render.decodeFrameDelta(
      session.buildDisplayPagesFrame([index], frame.frameEpoch),
    ),
  );
  return state.frame.displayList.pages[index];
}

function pageSizes() {
  return required().frame.displayList.pages.map((page) => ({
    width: page.width,
    height: page.height,
    background: page.background,
  }));
}

function pageText(index) {
  const page = built(index);
  if (!page) return [];
  const { render } = modules;
  const measure = state.measure;
  const primitives = [
    ...(page.header?.primitives ?? []),
    ...page.primitives.slice(page.watermarkPrimitiveCount ?? 0),
    ...(page.footer?.primitives ?? []),
  ];
  return primitives.flatMap((primitive) => {
    if (
      (primitive.kind !== "text" && primitive.kind !== "glyphRun") ||
      !primitive.text ||
      primitive.decorative
    )
      return [];
    const rect =
      primitive.kind === "glyphRun"
        ? render.glyphRunRect(primitive)
        : render.textRunRect(primitive);
    const size =
      primitive.kind === "glyphRun"
        ? primitive.size
        : render.fontSizePxFromShorthand(primitive.font);
    const baseline =
      primitive.kind === "glyphRun"
        ? ((
            primitive.glyphs.find((glyph) => glyph.advance) ??
            primitive.glyphs[0]
          )?.y ?? 0)
        : primitive.baselineY;
    const natural = measure.width(primitive.text);
    const stretch = natural > 0 && rect.w > 0 ? rect.w / (natural * size) : 1;
    const above = (1.2 + measure.ascent - measure.descent) / 2;
    return [
      {
        text: primitive.text,
        left: rect.x / page.width,
        top: (baseline - size * above) / page.height,
        size: size / page.width,
        transform: `scaleX(${stretch})`,
        dir: primitive.rtl || primitive.bidiLevel % 2 === 1 ? "rtl" : "ltr",
        after: "br",
      },
    ];
  });
}

function bookmarkTarget(name) {
  const { session } = required();
  state.projection ??= modules.yrs.createYrsPositionProjection(session, "body");
  const position = state.projection.bookmarkPosition(name);
  if (position === undefined) {
    return name === "_top" ? { index: 0, y: 0 } : undefined;
  }
  for (const [index, listed] of state.frame.displayList.pages.entries()) {
    const page = built(index);
    if (!page) continue;
    const first = page.primitives
      .filter((primitive) => primitive.docStart >= position)
      .sort((a, b) => a.docStart - b.docStart)[0];
    if (first) return { index, y: first.y };
  }
  return undefined;
}

serveRpc({
  async open({ bytes }) {
    const pages = await openDocument(bytes);
    return { pages, loading: false };
  },
  layout() {
    return {
      done: true,
      pages: pageSizes(),
      kept: pageSizes().map(() => true),
    };
  },
  async paint({ index, scale, ratio }, signal) {
    if (signal.aborted) return undefined;
    const page = built(index);
    if (!page) return undefined;
    const canvas = state.surface;
    const width = Math.ceil(page.width * ratio * scale);
    const height = Math.ceil(page.height * ratio * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.imageSmoothingQuality = "medium";
    await modules.render.rasterizeDisplayPageToBackBuffer(
      canvas,
      page,
      {
        glyphCache: state.glyphCache,
        resolveImage: async (mediaToken) => {
          const media = state.session.mediaSource(mediaToken);
          if (!media) return null;
          return createImageBitmap(
            new Blob([media.bytes], { type: media.mimeType }),
          ).catch(() => null);
        },
      },
      ratio,
      scale,
    );
    if (signal.aborted) return undefined;
    const bitmap = canvas.transferToImageBitmap();
    return new Transfer(bitmap, [bitmap]);
  },
  build({ index }) {
    built(index);
    return undefined;
  },
  text({ index }) {
    return pageText(index);
  },
  bookmark({ name }) {
    return bookmarkTarget(name);
  },
});
