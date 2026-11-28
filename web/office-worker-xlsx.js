import { serveRpc, Transfer } from "./office-worker-rpc.js";

const token = new URL(self.location.href).searchParams.get("token") ?? "";
const engineUrl = `/engine/@betteroffice/xlsx/dist/index.js?token=${encodeURIComponent(token)}`;
const LAST_ROW = 1048575;
const LAST_COL = 16383;

let engine;
let state;

async function loadEngine() {
  if (engine) return engine;
  engine = await import(engineUrl);
  return engine;
}

function required() {
  if (!state) throw new Error("The worker holds no workbook");
  return state;
}

function activate(sheet) {
  const opened = required();
  if (opened.info.activeSheet !== sheet) {
    opened.workbook.setActiveSheet(sheet);
    opened.info = opened.workbook.sheetInfo();
  }
  return opened.info;
}

function showSheet(sheet) {
  const opened = required();
  const previous = opened.info;
  try {
    activate(sheet);
    return {
      info: opened.info,
      used: undefined,
      merges: [],
      hidden: { rows: [], columns: [] },
      chartWidth: 0,
      chartHeight: 0,
    };
  } catch (error) {
    opened.info = previous;
    opened.workbook.setActiveSheet(previous.activeSheet);
    throw error;
  }
}

function readCells(sheet, range) {
  const opened = required();
  const result = opened.workbook.readCells({
    ranges: [
      {
        sheetId: opened.info.sheetIds[sheet],
        range: {
          kind: "rowCol",
          start: { row: range.top, col: range.left },
          end: { row: range.bottom, col: range.right },
        },
      },
    ],
  });
  return result.ok ? result.ranges[0]?.cells : undefined;
}

serveRpc({
  async open({ bytes }) {
    const api = await loadEngine();
    await api.initWasm();
    const workbook = api.openWorkbook(new Uint8Array(bytes));
    const info = workbook.sheetInfo();
    state = { workbook, info, surface: new OffscreenCanvas(1, 1) };
    const tabs = info.sheetNames.map((name, index) => ({ index, name }));
    const first = tabs.find((tab) => tab.index === info.activeSheet) ?? tabs[0];
    if (!first) return undefined;
    return { tabs, layout: showSheet(first.index) };
  },
  show({ sheet }) {
    return showSheet(sheet);
  },
  frame({ sheet, x, y, width, height, ratio }) {
    const api = engine;
    activate(sheet);
    try {
      const list = state.workbook.displayList({ x, y, width, height });
      const canvas = state.surface;
      const bitmapWidth = Math.max(1, Math.ceil(width * ratio));
      const bitmapHeight = Math.max(1, Math.ceil(height * ratio));
      if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
      if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      api.paintDisplayList(context, list, ratio, { x: 0, y: 0 });
      const bitmap = canvas.transferToImageBitmap();
      return new Transfer(
        {
          bitmap,
          grid: list.grid ?? null,
          viewport: { x, y, width, height },
        },
        [bitmap],
      );
    } catch {
      return undefined;
    }
  },
  position({ sheet, cell }) {
    const workbook = required().workbook;
    try {
      const start = workbook.cellPosition(sheet, cell.row, cell.col);
      const next = workbook.cellPosition(
        sheet,
        Math.min(cell.row + 1, LAST_ROW),
        Math.min(cell.col + 1, LAST_COL),
      );
      return { start, next };
    } catch {
      return undefined;
    }
  },
  cells({ sheet, range }) {
    const cells = readCells(sheet, range);
    return Array.from({ length: range.bottom - range.top + 1 }, (_, row) =>
      Array.from(
        { length: range.right - range.left + 1 },
        (_, col) => cells?.[row]?.[col]?.displayText ?? "",
      ),
    );
  },
  copy({ sheet, range }) {
    const cells = readCells(sheet, range);
    if (!cells) return undefined;
    return engine.toTsv(
      cells.map((row) => row.map((cell) => ({ input: cell.displayText }))),
    );
  },
});
